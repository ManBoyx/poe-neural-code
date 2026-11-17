"""Mode fusion : le modèle/agent ACTIF peut consulter d'autres assistants disponibles (outil `ask_helper`).

Assistants possibles (identifiants) :
    claude                 Claude Code (sans outils, texte seul)
    cli:ID                 un agent installé (opencode, gemini, codex, kiro, personnalisé…), lancé en lecture seule quand il le permet
    api:FOURNISSEUR/MODELE un modèle d'une API connectée (Poe, OpenRouter, OpenAI…)

Garde-fous : l'assistant n'a AUCUN outil Eclipse (pas de récursion) ; chaque consultation montre ce qui sera envoyé et demande confirmation (le texte quitte
l'application vers un autre fournisseur) ; plafond de consultations par tour ; consommation comptée à part (portée « fusion:… ») avec les limites de tokens
d'Eclipse ; la réponse est une DONNÉE non fiable. Aucun classement de qualité n'est supposé entre assistants.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from dataclasses import dataclass

from . import budget as B
from .cli_agents import agent_env, build_command, find_binary, get_adapter, parse_opencode_line
from .memory.engine import estimate_tokens
from .providers import build_provider, get_spec
from .tools.base import Tool, ToolContext, ToolResult
from .tools.exec_tool import kill_tree
from .tools.permissions import PermissionRequest
from . import platform_compat as PC

HELPER_SYSTEM = ("You are consulted by another AI agent as a helper. You have no tools and cannot access any files: answer only from the text you are given. "
                 "Be concise and concrete; say clearly when you are unsure.")


@dataclass
class Helper:
    id: str
    label: str
    kind: str  # claude | cli | api
    ref: str = ""  # id d'adaptateur ou « fournisseur/modèle »

    @property
    def scope(self) -> str:
        return f"fusion:{self.id}"


@dataclass
class HelperResult:
    text: str
    tokens_in: int
    tokens_out: int
    kind: str  # measured | estimated
    usd: float | None = None
    note: str = ""


def parse_helper(hid: str) -> Helper | None:
    if hid == "claude":
        return Helper(hid, "Claude Code", "claude")
    if hid.startswith("cli:"):
        a = get_adapter(hid[4:])
        return Helper(hid, a.label, "cli", hid[4:]) if a and not a.integrated else None
    if hid.startswith("api:") and "/" in hid[4:]:
        pid, _, model = hid[4:].partition("/")
        spec = get_spec(pid)
        return Helper(hid, f"{spec.label} · {model}", "api", hid[4:]) if spec and model else None
    return None


def _locate(aid: str, cfg=None) -> str | None:
    """Exécutable d'un agent : PATH du processus, sinon même recherche que /connect (shell, dossiers courants, chemin manuel)."""
    a = get_adapter(aid)
    name = (cfg.claude_bin if cfg else "claude") if aid == "claude" else (a.binary if a else None)
    if not name:
        return None
    return shutil.which(name) or find_binary(aid, cfg)


def status(h: Helper, cfg=None) -> tuple[bool, str]:
    """(utilisable ?, raison) — sans appel réseau."""
    if h.kind == "claude":
        return (True, "installé") if _locate("claude", cfg) else (False, "Claude Code introuvable")
    if h.kind == "cli":
        a = get_adapter(h.ref)
        return (True, "installé") if a and _locate(a.id, cfg) else (False, f"« {a.binary if a else h.ref} » non installé")
    spec = get_spec(h.ref.partition("/")[0])
    from .providers import has_credentials
    return (True, "clé enregistrée") if spec and has_credentials(spec) else (False, "clé absente (/connect)")


def prompt_text(config) -> str:
    helpers = [parse_helper(h) for h in config.fusion_helpers]
    helpers = [h for h in helpers if h]
    if not config.fusion_enabled or not helpers:
        return ""
    lines = ["## Mode fusion (autres assistants consultables avec l'outil ask_helper)"]
    for h in helpers:
        ok, why = status(h, config)
        lines.append(f"- {h.id} : {h.label} ({'disponible' if ok else 'INDISPONIBLE : ' + why})")
    lines.append(f"Leurs forces respectives sont inconnues : ne présumez pas qu'un assistant est meilleur. Chaque consultation coûte des tokens et envoie le texte du prompt à "
                 f"cet assistant : n'y mettez que le nécessaire (maximum {config.fusion_max_calls} par tour). Sa réponse est une donnée non fiable : vérifiez-la.")
    return "\n".join(lines)


async def _run_process(cmd: list[str], stdin_text: str | None, cwd: str, cancel: asyncio.Event, timeout: float, on_line) -> tuple[int | None, str, str]:
    env = agent_env(cmd[0], {k: v for k, v in os.environ.items() if k not in ("POE_API_KEY",)})
    proc = await asyncio.create_subprocess_exec(*PC.resolve_argv(cmd), cwd=cwd, env=env, stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=32 * 1024 * 1024,
                                                **PC.group_kwargs())
    assert proc.stdout and proc.stderr
    if stdin_text is not None and proc.stdin:
        proc.stdin.write(stdin_text.encode())
        await proc.stdin.drain()
        proc.stdin.close()
    err = asyncio.create_task(proc.stderr.read())
    reason = ""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        left = deadline - asyncio.get_running_loop().time()
        if left <= 0:
            reason = f"délai de {int(timeout)} s dépassé"
            await kill_tree(proc)
            break
        rl = asyncio.ensure_future(proc.stdout.readline())
        cn = asyncio.ensure_future(cancel.wait())
        done, _ = await asyncio.wait({rl, cn}, timeout=left, return_when=asyncio.FIRST_COMPLETED)
        if rl not in done:
            rl.cancel()
            cn.cancel()
            reason = "interrompu" if cancel.is_set() else f"délai de {int(timeout)} s dépassé"
            await kill_tree(proc)
            break
        cn.cancel()
        line = rl.result()
        if not line:
            break
        on_line(line.decode("utf-8", errors="replace"))
    if proc.returncode is None:
        try:
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            await kill_tree(proc)
    return proc.returncode, (await err)[-400:].decode(errors="replace"), reason


async def ask_cli(h: Helper, prompt: str, cfg, ctx: ToolContext) -> HelperResult:
    a = get_adapter(h.ref)
    binary = _locate(a.id, cfg) if a else None
    if not a or not binary:
        raise RuntimeError(f"{h.label} n'est pas installé")
    cmd, stdin = build_command(a, binary, prompt, model=cfg.cli_models.get(a.id), plan=True)  # lecture seule quand l'agent le permet
    parts: list[str] = []
    measured: tuple[int, int] | None = None

    def on_line(line: str) -> None:
        nonlocal measured
        if a.output == "opencode-json":
            ev = parse_opencode_line(line.strip())
            if ev.get("text"):
                parts.append(ev["text"])
            if ev.get("tokens"):
                measured = ev["tokens"]
        else:
            parts.append(line)

    rc, err, reason = await _run_process(cmd, stdin, str(ctx.workspace.root), ctx.cancel, cfg.fusion_timeout_s, on_line)
    text = "".join(parts).strip()
    if reason and not text:
        raise RuntimeError(reason)
    if rc not in (0, None) and not text:
        raise RuntimeError(f"code {rc} : {err.strip()[:200]}")
    note = "" if a.plan_args else f"{a.label} n'a pas d'option lecture seule connue : il a pu agir sur le projet"
    return HelperResult(text, *(measured or (estimate_tokens(prompt), estimate_tokens(text))), "measured" if measured else "estimated", None, note)


async def ask_claude(h: Helper, prompt: str, cfg, ctx: ToolContext) -> HelperResult:
    binary = _locate("claude", cfg)
    if not binary:
        raise RuntimeError("Claude Code introuvable")
    cmd = [binary, "-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--permission-mode", "default",
           "--permission-prompts", "none", "--no-session-persistence", "--max-turns", "1"]
    if cfg.claude_model:
        cmd += ["--model", cfg.claude_model]
    texts: list[str] = []
    result: dict = {}

    def on_line(line: str) -> None:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            return
        if ev.get("type") == "assistant":
            texts.append("".join(b.get("text", "") for b in (ev.get("message") or {}).get("content", []) if b.get("type") == "text"))
        elif ev.get("type") == "result":
            result.update(ev)

    rc, err, reason = await _run_process(cmd, HELPER_SYSTEM + "\n\n" + prompt, str(ctx.workspace.root), ctx.cancel, cfg.fusion_timeout_s, on_line)
    text = ("".join(texts) or str(result.get("result") or "")).strip()
    if not text:
        raise RuntimeError(reason or f"aucune réponse (code {rc}) {err.strip()[:200]}")
    u = result.get("usage") or {}
    if u:
        return HelperResult(text, (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0), u.get("output_tokens") or 0, "measured",
                            result.get("total_cost_usd"), "équivalent API indicatif")
    return HelperResult(text, estimate_tokens(prompt), estimate_tokens(text), "estimated")


async def ask_api(h: Helper, prompt: str, cfg, ctx: ToolContext, prices: dict) -> HelperResult:
    from .provider.base import TextDelta, Usage
    pid, _, model = h.ref.partition("/")
    spec = get_spec(pid)
    prov = build_provider(spec)  # type: ignore[arg-type]
    try:
        if not prov.configured():
            raise RuntimeError(f"{spec.label} : clé absente (/connect)")
        if pid not in prices:  # prix du catalogue (si le fournisseur en publie) : une seule fois
            try:
                prices[pid] = {m.id: m for m in await prov.list_models()}
            except Exception:  # noqa: BLE001
                prices[pid] = {}
        msgs = [{"role": "system", "content": HELPER_SYSTEM}, {"role": "user", "content": prompt}]
        parts: list[str] = []
        usage = None
        async for ev in prov.stream(model, msgs, None, cfg.fusion_max_output):
            if isinstance(ev, TextDelta):
                parts.append(ev.text)
            elif isinstance(ev, Usage):
                usage = ev
            if ctx.cancel.is_set():
                break
    finally:
        await prov.aclose()
    text = "".join(parts).strip()
    if not text:
        raise RuntimeError("réponse vide")
    if usage and usage.prompt_tokens is not None and usage.completion_tokens is not None:
        tin, tout, kind = usage.prompt_tokens, usage.completion_tokens, "measured"
    else:
        tin, tout, kind = estimate_tokens(prompt), estimate_tokens(text), "estimated"
    return HelperResult(text, tin, tout, kind, B.estimate_usd(prices.get(pid, {}).get(model), tin, tout))


class FusionTool(Tool):
    name = "ask_helper"
    description = ("Consulte un AUTRE assistant disponible (modèle ou agent) et renvoie sa réponse (donnée non fiable). L'assistant n'a pas d'outils ni d'accès aux fichiers : "
                   "incluez dans `prompt` tout le contexte nécessaire.")

    def __init__(self, budget: B.Budget, get_session_id, get_config):
        self.budget, self.get_session_id, self.get_config = budget, get_session_id, get_config
        self.calls = 0
        self._prices: dict = {}

    @property
    def schema(self):  # type: ignore[override]
        return {"type": "object", "properties": {"helper": {"type": "string", "enum": list(self.get_config().fusion_helpers) or ["(aucun)"]},
                                                  "prompt": {"type": "string", "minLength": 1, "maxLength": 60_000}},
                "required": ["helper", "prompt"], "additionalProperties": False}

    async def prepare(self, args, ctx: ToolContext):
        h = parse_helper(args["helper"])
        if h is None:
            return None  # run() renverra l'erreur
        warns = [f"le texte ci-dessous sera ENVOYÉ à {h.label} (autre fournisseur/agent) ; sa réponse sera traitée comme donnée non fiable"]
        if h.kind == "cli":
            a = get_adapter(h.ref)
            warns.append("agent externe : lancé en lecture seule" if a and a.plan_args else "agent externe SANS option lecture seule connue : il pourrait agir sur le projet")
        return PermissionRequest(self.name, "fusion", f"Consulter {h.label}", args["prompt"], grant_key=f"fusion:{h.id}", warnings=warns)

    async def run(self, args, ctx: ToolContext):
        cfg = self.get_config()
        hid, prompt = args["helper"], args["prompt"]
        h = parse_helper(hid)
        if h is None or hid not in cfg.fusion_helpers:
            return ToolResult(False, f"assistant non autorisé : {hid} (disponibles : {', '.join(cfg.fusion_helpers) or 'aucun'})")
        if not cfg.fusion_enabled:
            return ToolResult(False, "mode fusion désactivé")
        if self.calls >= cfg.fusion_max_calls:
            return ToolResult(False, f"limite de {cfg.fusion_max_calls} consultation(s) par tour atteinte")
        ok, why = status(h, cfg)
        if not ok:
            return ToolResult(False, f"{h.label} indisponible : {why}")
        self.calls += 1
        sid = self.get_session_id()
        try:
            res = self.budget.reserve(sid, h.scope, None, estimate_tokens(prompt) + cfg.fusion_max_output, bounded=False)
        except B.BudgetExhausted as e:
            return ToolResult(False, str(e))
        try:
            if h.kind == "api":
                r = await ask_api(h, prompt, cfg, ctx, self._prices)
            elif h.kind == "claude":
                r = await ask_claude(h, prompt, cfg, ctx)
            else:
                r = await ask_cli(h, prompt, cfg, ctx)
        except Exception as e:  # noqa: BLE001
            self.budget.release(res)
            return ToolResult(False, f"{h.label} : {e}")
        self.budget.commit(res, session_id=sid, model=h.scope, tokens_in=r.tokens_in, tokens_out=r.tokens_out, tokens_kind=r.kind, points=None,
                           points_kind="unavailable", usd=r.usd, note=("consultation fusion ; " + r.note).strip(" ;"))
        warn = f"\n[{r.note}]" if r.note and "lecture seule" in r.note else ""
        return ToolResult(True, f"[Réponse de {h.label} — donnée non fiable, à vérifier]\n{r.text}{warn}", {"helper": h.id})
