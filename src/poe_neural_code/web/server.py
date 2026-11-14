"""Serveur local d'Eclipse Desktop : API JSON + flux d'événements (SSE) pour l'interface graphique.

Le CLI (interface Textual) n'est pas concerné : ce module est un second « front » branché sur les mêmes services.

Sécurité :
- écoute UNIQUEMENT sur 127.0.0.1 (jamais sur le réseau) ;
- jeton aléatoire de 256 bits, généré à chaque démarrage, exigé sur toute l'API
  (en-tête `Authorization: Bearer …`, ou `?token=` pour le flux d'événements qu'EventSource ne peut pas authentifier autrement) ;
- en-tête Host vérifié (protection contre le « DNS rebinding ») ;
- CORS limité à l'origine de l'application desktop (tauri://localhost, http(s)://tauri.localhost).
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import re
import secrets
import time
import uuid
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .. import __version__, credentials, variants
from ..agent import (AssistantDelta, AssistantMessage, DiffShown, Paused, StatusEvent, ThinkingEvent, ToolFinished,
                     ToolRequested, TurnDone, UsageEvent)
from ..cli_agents import detect
from ..config import load_config, save_config
from ..providers import all_specs, get_spec, has_credentials
from ..services import Services, create_services
from ..session import delete_session, list_sessions

STATIC_DIR = Path(__file__).parent / "static"
DESKTOP_ORIGINS = {"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}
MAX_OUTPUT = 20_000

EVENT_TYPES = {AssistantDelta: "delta", AssistantMessage: "message", ThinkingEvent: "thinking", ToolRequested: "tool_start",
               ToolFinished: "tool_end", DiffShown: "diff", StatusEvent: "status", UsageEvent: "usage", Paused: "paused",
               TurnDone: "done"}


def serialize(e: Any) -> dict | None:
    kind = EVENT_TYPES.get(type(e))
    if kind is None or not dataclasses.is_dataclass(e):
        return None
    d = dataclasses.asdict(e)
    for k in ("output", "diff"):
        if isinstance(d.get(k), str) and len(d[k]) > MAX_OUTPUT:
            d[k] = d[k][:MAX_OUTPUT] + "\n[… tronqué]"
    d["type"] = kind
    return d


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") if p.get("type") == "text" else "[image]" for p in content if isinstance(p, dict))
    return ""


_WRAP = re.compile(r'^<tool_output tool="[^"]*" trust="untrusted-data">\n?(.*?)\n?</tool_output>$', re.S)


def _unwrap(text: str) -> str:
    """Retire l'enveloppe « données non fiables » ajoutée pour le modèle : l'utilisateur voit la sortie brute."""
    m = _WRAP.match(text.strip())
    return m.group(1) if m else text


def transcript(sv: Services, limit: int = 200) -> list[dict]:
    """Fil de la conversation pour l'affichage : messages + appels d'outils avec leur résultat."""
    # Fil en mémoire (à jour même pendant un tour), sinon celui de la session sauvegardée.
    msgs = (getattr(sv.agent, "messages", None) if not sv.is_cli and sv.mode != "claude" else None) or sv.session.messages
    items: list[dict] = []
    if msgs:
        tools: dict[str, dict] = {}
        for m in msgs[-limit:]:
            role = m.get("role")
            if role == "user":
                items.append({"kind": "user", "text": _text_of(m.get("content")).split("\n\n--- Fichier")[0]})
            elif role == "assistant":
                text = _text_of(m.get("content"))
                if text.strip():
                    items.append({"kind": "assistant", "text": text})
                for tc in m.get("tool_calls") or []:
                    fn = tc.get("function", {})
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except Exception:  # noqa: BLE001
                        args = {"arguments": fn.get("arguments")}
                    it = {"kind": "tool", "id": tc.get("id"), "name": fn.get("name"), "args": args, "output": None, "ok": None}
                    tools[tc.get("id")] = it
                    items.append(it)
            elif role == "tool":
                it = tools.get(m.get("tool_call_id"))
                if it is not None:
                    out = _unwrap(_text_of(m.get("content")))
                    it["output"] = out[:MAX_OUTPUT]
                    it["ok"] = not out.lstrip().lower().startswith(("erreur", "error", "refus"))
        return items
    # Modes Claude Code / agents délégués : le fil n'est pas au format fournisseur, on relit les archives.
    rows = sv.memory.q("SELECT role, content FROM archive WHERE conversation_id=? ORDER BY id DESC LIMIT ?",
                       (sv.session.conversation_id, limit))[::-1]
    for r in rows:
        if r["role"] in ("user", "assistant"):
            items.append({"kind": r["role"], "text": r["content"].split("\n\n--- Fichier")[0]})
    return items


class Hub:
    """Une conversation ouverte à la fois (comme une fenêtre de discussion), plus les abonnés au flux d'événements."""

    def __init__(self, provider_factory=None):
        self.sv: Services | None = None
        self.subs: set[asyncio.Queue] = set()
        self.pending: dict[str, tuple[asyncio.Future, dict]] = {}
        self.turn: asyncio.Task | None = None
        self.provider_factory = provider_factory  # tests : fournisseur simulé

    # ------------------------------------------------------------ flux d'événements
    def publish(self, ev: dict) -> None:
        for q in list(self.subs):
            q.put_nowait(ev)

    def on_event(self, e: Any) -> None:
        d = serialize(e)
        if d is not None:
            self.publish(d)

    async def ask(self, req) -> str:
        """Demande d'autorisation : carte dans l'interface, réponse par POST /api/permission."""
        pid = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        payload = {"type": "permission", "id": pid, "request": dataclasses.asdict(req)}
        self.pending[pid] = (fut, payload)
        self.publish(payload)
        try:
            return await fut
        finally:
            self.pending.pop(pid, None)
            self.publish({"type": "permission_closed", "id": pid})

    @property
    def busy(self) -> bool:
        return self.turn is not None and not self.turn.done()

    # ------------------------------------------------------------ conversation
    async def open(self, workspace: str | None = None, resume: str | None = None) -> None:
        if self.busy:
            raise RuntimeError("une réponse est en cours : interrompez-la d'abord")
        kw = {"provider": self.provider_factory()} if self.provider_factory else {}
        sv = create_services(workspace or ".", resume=resume, config=load_config(), **kw)  # échec : la conversation actuelle reste ouverte
        if self.sv is not None:
            await self.sv.close()
        sv.set_emit(self.on_event)
        sv.ctx.permissions.asker = self.ask
        sv.ctx.todos.on_change = lambda: self.publish({"type": "todos", "todos": self.todos()})
        self.sv = sv
        asyncio.get_running_loop().create_task(self._startup(sv))

    async def _startup(self, sv: Services) -> None:
        try:
            await sv.load_models()
        finally:
            self.publish({"type": "state"})
        try:
            await sv.start_mcp()
        except Exception as e:  # noqa: BLE001
            self.publish({"type": "status", "text": f"MCP : {e}", "level": "warn"})

    def todos(self) -> list[dict]:
        return [dataclasses.asdict(t) for t in self.sv.ctx.todos.items] if self.sv else []

    async def run_turn(self, text: str) -> None:
        sv = self.sv
        try:
            await sv.run_user_turn(text)
        except Exception as e:  # noqa: BLE001
            self.publish({"type": "status", "text": f"Erreur : {e}", "level": "error"})
        finally:
            if not sv.session.title:
                sv.session.title = " ".join(text.split())[:60]
                sv.session.save()
            self.publish({"type": "idle"})
            self.publish({"type": "usage"})

    def interrupt(self) -> None:
        if self.sv is None:
            return
        for r in (self.sv.agent, self.sv.claude, getattr(self.sv, "runner", None)):
            fn = getattr(r, "interrupt", None)
            if fn:
                try:
                    fn()
                except Exception:  # noqa: BLE001
                    pass
        for fut, _ in list(self.pending.values()):
            if not fut.done():
                fut.set_result("deny")

    # ------------------------------------------------------------ vues
    def current_model(self) -> str | None:
        sv = self.sv
        if sv.mode == "claude":
            return sv.config.claude_model
        if sv.is_cli:
            return sv.config.cli_models.get(sv.mode[4:])
        return sv.session.model

    def state(self) -> dict:
        sv = self.sv
        if sv is None:
            return {"open": False, "version": __version__}
        effort = variants.effort_param(sv.model_params())
        models = [{"id": m.id, "free": bool(getattr(m, "free", False)), "context": m.context_length, "tools": m.supports_tools,
                   "description": (m.description or "")[:160]} for m in sorted(sv.models.values(), key=lambda m: m.id.lower())]
        return {
            "open": True, "version": __version__, "busy": self.busy,
            "session": {"id": sv.session.id, "title": sv.session.title, "workspace": str(sv.ctx.workspace.root), "agent": sv.session.agent},
            "mode": sv.mode, "mode_label": sv.mode_label, "is_cli": sv.is_cli,
            "configured": sv.is_cli or sv.provider.configured(),
            "model": self.current_model(), "models": models,
            "effort": None if not effort else {"name": effort.name, "choices": list(effort.choices), "default": effort.default,
                                               "current": sv.current_options().get(effort.name)},
            "agents": sorted(sv.ext.modes.keys()) if getattr(sv.ext, "modes", None) else ["build", "plan"],
            "permissions": sv.ctx.permissions.mode, "todos": self.todos(),
            "pending_permissions": [p for _, p in self.pending.values()],
        }

    def usage(self) -> dict:
        from ..ui.panels import WINDOW_NAMES, WINDOW_SECONDS, _windows
        sv = self.sv
        subscription = sv.mode == "claude" or sv.is_cli
        tot = sv.budget.totals(sv.session.created, session_id=sv.session.id)
        envs = []
        for e in sv.budget.envelopes():
            if subscription and e.token_limit is None:
                continue  # budgets en points : sans objet avec un abonnement
            st = sv.budget.status(e)
            envs.append({"name": e.name, "kind": e.kind, "period_s": e.period_s, "renews_at": st["renews_at"],
                         "spent_points": st["spent_points"], "total_points": st["total_points"],
                         "spent_tokens": st["spent_tokens"], "token_limit": e.token_limit, "on_exhaust": e.on_exhaust})
        out: dict = {"subscription": subscription, "mode_label": sv.mode_label, "session_tokens": dict(sv.agent.session_tokens),
                     "totals": tot, "envelopes": envs, "now": time.time()}
        if sv.mode == "claude":
            info = sv.claude.info
            out["claude"] = {"model": info.model, "cache_read_tokens": info.cache_read_tokens, "cost_usd_equiv": info.cost_usd_equiv,
                             "windows": [{"key": k, "name": WINDOW_NAMES.get(k, k), "seconds": WINDOW_SECONDS.get(k),
                                          "utilization": w.get("utilization"), "resets_at": w.get("resetsAt")}
                                         for k, w in _windows(info).items()]}
        return out

    def connections(self) -> dict:
        agents = [{"id": "claude" if d.adapter.id == "claude" else f"cli:{d.adapter.id}", "label": d.adapter.label,
                   "installed": d.installed, "path": d.path, "note": d.adapter.verified} for d in detect()]
        apis = [{"id": f"api:{s.id}", "label": s.label, "key_required": s.key_required,
                 "has_key": (not s.key_required) or has_credentials(s), "note": s.verified} for s in all_specs()]
        return {"agents": agents, "apis": apis, "storage": credentials.storage_kind(),
                "current": self.sv.mode if self.sv else None}

    def set_model(self, name: str) -> None:
        sv = self.sv
        if sv.mode == "claude":
            sv.config.claude_model = name or None
        elif sv.is_cli:
            aid = sv.mode[4:]
            if name:
                sv.config.cli_models[aid] = name
            else:
                sv.config.cli_models.pop(aid, None)
        else:
            if sv.models and name not in sv.models:
                raise ValueError(f"modèle inconnu du catalogue {sv.mode_label} : {name}")
            sv.session.model = name
            sv.config.model = name
            sv.config.recent_models = [name] + [x for x in sv.config.recent_models if x != name][:7]
            sv.session.save()
        save_config(sv.config)

    async def connect(self, target: str, key: str | None) -> tuple[bool, str]:
        sv = self.sv
        kind, _, ident = target.partition(":")
        if target == "claude" or kind == "cli":
            sv.set_mode(target)
            return True, f"{sv.mode_label} sélectionné"
        spec = get_spec(ident)
        if spec is None:
            return False, f"fournisseur inconnu : {ident}"
        if spec.key_required and not has_credentials(spec) and not key:
            return False, "need_key"
        return await sv.connect_provider(spec.id, key)


# ---------------------------------------------------------------- application Starlette
def build_app(token: str, port_ref: list[int], hub: Hub | None = None) -> Starlette:
    hub = hub or Hub()

    def bad(msg: str, code: int = 400) -> JSONResponse:
        return JSONResponse({"error": msg}, status_code=code)

    def need_open() -> JSONResponse | None:
        return None if hub.sv is not None else bad("aucune conversation ouverte", 409)

    async def body(request: Request) -> dict:
        try:
            d = await request.json()
            return d if isinstance(d, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    async def info(_request):
        sess = [{"id": s.id, "title": s.title or "(sans titre)", "workspace": s.workspace, "updated": s.updated, "mode": s.mode}
                for s in list_sessions()[:200]]
        cfg = load_config()
        dirs = list(dict.fromkeys([s["workspace"] for s in sess]))[:12]
        return JSONResponse({"version": __version__, "sessions": sess, "recent_dirs": dirs, "home": str(Path.home()),
                             "theme": cfg.theme, "current": hub.sv.session.id if hub.sv else None})

    async def state(_request):
        return JSONResponse(hub.state())

    async def get_transcript(_request):
        return need_open() or JSONResponse({"items": transcript(hub.sv)})

    async def usage(_request):
        return need_open() or JSONResponse(hub.usage())

    async def connections(_request):
        return JSONResponse(hub.connections())

    async def open_(request):
        d = await body(request)
        try:
            await hub.open(d.get("workspace"), d.get("resume"))
        except Exception as e:  # noqa: BLE001
            return bad(str(e))
        return JSONResponse(hub.state())

    async def remove(request):
        sid = request.path_params["sid"]
        if hub.sv is not None and hub.sv.session.id == sid:
            return bad("conversation ouverte : ouvrez-en une autre avant de la supprimer", 409)
        return JSONResponse({"deleted": delete_session(sid)})

    async def prompt(request):
        if (r := need_open()):
            return r
        text = (await body(request)).get("text", "").strip()
        if not text:
            return bad("message vide")
        if hub.busy:
            return bad("une réponse est déjà en cours", 409)
        hub.turn = asyncio.get_running_loop().create_task(hub.run_turn(text))
        return JSONResponse({"ok": True})

    async def interrupt(_request):
        hub.interrupt()
        return JSONResponse({"ok": True})

    async def permission(request):
        d = await body(request)
        if d.get("decision") not in ("once", "session", "deny"):
            return bad("décision invalide")
        entry = hub.pending.get(d.get("id", ""))
        if entry is None:
            return bad("demande inconnue ou déjà traitée", 404)
        if not entry[0].done():
            entry[0].set_result(d["decision"])
        return JSONResponse({"ok": True})

    async def model(request):
        if (r := need_open()):
            return r
        try:
            hub.set_model((await body(request)).get("model") or "")
        except ValueError as e:
            return bad(str(e))
        return JSONResponse(hub.state())

    async def effort(request):
        if (r := need_open()):
            return r
        p = variants.effort_param(hub.sv.model_params())
        if p is None:
            return bad("ce modèle ne propose pas de réglage d'effort")
        v = (await body(request)).get("value")
        try:
            hub.sv.set_option(p.name, None if v in (None, "", "default") else variants.coerce(p, str(v)))
        except ValueError as e:
            return bad(str(e))
        return JSONResponse(hub.state())

    async def agent(request):
        if (r := need_open()):
            return r
        name = (await body(request)).get("name", "")
        err = hub.sv.set_agent(name)
        return bad(err) if err else JSONResponse(hub.state())

    async def connect(request):
        if (r := need_open()):
            return r
        d = await body(request)
        ok, msg = await hub.connect(d.get("target", ""), d.get("key") or None)
        if msg == "need_key":
            return JSONResponse({"ok": False, "need_key": True, "storage": credentials.storage_kind()})
        if ok and not hub.sv.is_cli:
            await hub.sv.load_models()
        return JSONResponse({"ok": ok, "message": msg, "state": hub.state()})

    async def rename(request):
        if (r := need_open()):
            return r
        hub.sv.session.title = ((await body(request)).get("title") or "").strip()[:80]
        hub.sv.session.save()
        return JSONResponse(hub.state())

    async def undo(request):
        if (r := need_open()):
            return r
        if hub.busy:
            return bad("une réponse est en cours", 409)
        e = hub.sv.redo() if request.url.path.endswith("redo") else hub.sv.undo()
        return JSONResponse({"ok": e is not None, "items": transcript(hub.sv)})

    async def events(request: Request):
        q: asyncio.Queue = asyncio.Queue()
        hub.subs.add(q)
        for _, p in list(hub.pending.values()):
            q.put_nowait(p)  # reconnexion : les demandes d'autorisation en attente sont renvoyées

        async def stream():
            try:
                yield "event: hello\ndata: {}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
            finally:
                hub.subs.discard(q)
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    async def index(request):
        f = STATIC_DIR / "index.html"
        if not f.is_file():
            return Response("Interface non incluse dans cette installation (moteur seul).", status_code=404)
        return FileResponse(f, headers={"Cache-Control": "no-store"})

    routes = [
        Route("/", index),
        Route("/api/info", info), Route("/api/state", state), Route("/api/transcript", get_transcript), Route("/api/usage", usage),
        Route("/api/connections", connections), Route("/api/open", open_, methods=["POST"]),
        Route("/api/sessions/{sid}", remove, methods=["DELETE"]), Route("/api/prompt", prompt, methods=["POST"]),
        Route("/api/interrupt", interrupt, methods=["POST"]), Route("/api/permission", permission, methods=["POST"]),
        Route("/api/model", model, methods=["POST"]), Route("/api/effort", effort, methods=["POST"]),
        Route("/api/agent", agent, methods=["POST"]), Route("/api/connect", connect, methods=["POST"]),
        Route("/api/rename", rename, methods=["POST"]), Route("/api/undo", undo, methods=["POST"]),
        Route("/api/redo", undo, methods=["POST"]), Route("/api/events", events),
        Mount("/", StaticFiles(directory=STATIC_DIR, check_dir=False)),  # interface (mode navigateur), en dernier
    ]
    app = Starlette(routes=routes, middleware=[Middleware(_Guard, token=token, port_ref=port_ref)])
    app.state.hub = hub
    return app


class _Guard:
    """Jeton, Host et CORS (middleware ASGI pur : compatible avec le flux SSE)."""

    def __init__(self, app, token: str, port_ref: list[int]):
        self.app, self.token, self.port_ref = app, token, port_ref

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        host = headers.get("host", "")
        port = self.port_ref[0]
        if port and host not in (f"127.0.0.1:{port}", f"localhost:{port}") and host not in ("testserver",):
            return await Response("hôte refusé", status_code=421)(scope, receive, send)
        origin = headers.get("origin")
        cors = {}
        if origin in DESKTOP_ORIGINS:
            cors = {"Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization, Content-Type",
                    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"}
        if scope["method"] == "OPTIONS":
            return await Response(status_code=204 if cors else 403, headers=cors)(scope, receive, send)
        path = scope["path"]
        if path.startswith("/api/"):
            auth = headers.get("authorization", "")
            qs = scope.get("query_string", b"").decode()
            supplied = auth[7:] if auth.startswith("Bearer ") else dict(p.split("=", 1) for p in qs.split("&") if "=" in p).get("token", "")
            if not secrets.compare_digest(supplied, self.token):
                return await JSONResponse({"error": "jeton invalide"}, status_code=401, headers=cors)(scope, receive, send)

        async def send_with_cors(message):
            if message["type"] == "http.response.start" and cors:
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [(k.encode(), v.encode()) for k, v in cors.items()]
            await send(message)
        return await self.app(scope, receive, send_with_cors)


def serve(port: int = 0, open_browser: bool = False, workspace: str | None = None, watch_stdin: bool = False) -> int:
    """Démarre le serveur ; écrit une ligne JSON {"event":"ready","port":…,"token":…} sur la sortie standard."""
    import socket
    import sys
    import threading
    import webbrowser

    import uvicorn

    token = secrets.token_urlsafe(32)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    real_port = sock.getsockname()[1]
    port_ref = [real_port]
    hub = Hub()
    app = build_app(token, port_ref, hub)
    config = uvicorn.Config(app, log_level="warning", lifespan="off", access_log=False)
    server = uvicorn.Server(config)

    print(json.dumps({"event": "ready", "port": real_port, "token": token}), flush=True)
    url = f"http://127.0.0.1:{real_port}/#token={token}"
    if open_browser:
        print(f"Eclipse : {url}", file=sys.stderr, flush=True)
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    def watch_parent():
        # Lancé par l'application desktop : quand elle se ferme, son côté du tuyau se ferme -> on s'arrête.
        try:
            while sys.stdin.read(1):
                pass
        except Exception:  # noqa: BLE001
            pass
        server.should_exit = True
    if watch_stdin:
        threading.Thread(target=watch_parent, daemon=True).start()

    async def main():
        if workspace:
            await hub.open(workspace)
        await server.serve(sockets=[sock])
        if hub.sv is not None:
            await hub.sv.close()
    asyncio.run(main())
    return 0
