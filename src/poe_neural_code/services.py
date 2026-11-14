"""Assemblage des services (sans interface) : testable et réutilisable par d.autres fronts."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from pathlib import Path

from .agent import Agent
from .claude_bridge import EclipseBridge
from .claude_runner import ClaudeCodeRunner
from . import credentials, variants
from .cli_agents import get_adapter
from .delegated_runner import DelegatedRunner
from .fusion import FusionTool
from .providers import build_provider, get_spec
from .provider.base import ProviderError
from .budget import Budget
from .extensions import Extensions
from .extensions.modes import cycle as cycle_mode
from .extensions.refs import expand_refs, find_images
from .extensions.skills import SkillTool
from .undo import Snapshots
from .config import Config, load_config
from .mcp_integration.manager import McpManager, load_mcp_config
from .memory.cache import WorkingCache
from .memory.engine import Memory
from .provider.base import Provider
from .provider.poe import PoeProvider
from .session import Session
from .tools.base import TodoList, ToolContext
from .tools.permissions import Asker, PermissionManager
from .tools.registry import builtin_tools
from .tools.workspace import Workspace


@dataclass
class Services:
    config: Config
    memory: Memory
    budget: Budget
    provider: Provider
    session: Session
    ctx: ToolContext
    agent: Agent
    mcp: McpManager
    claude: ClaudeCodeRunner
    bridge: EclipseBridge
    ext: Extensions
    snap: Snapshots
    models: dict = field(default_factory=dict)
    delegated: dict = field(default_factory=dict)
    fusion_tool: Any = None
    api_id: str = "poe"  # identifiant du fournisseur API actuellement branché sur l'agent
    _emit: Any = None

    async def load_models(self) -> None:
        try:
            self.models.clear()
            self.models.update({m.id: m for m in await self.provider.list_models()})
        except Exception:  # noqa: BLE001 — l'app reste utilisable ; les prix seront « indisponibles »
            pass

    async def start_mcp(self) -> None:
        await self.mcp.start()
        self.rebuild_tools()

    @property
    def mode(self) -> str:
        return self.session.mode

    @property
    def is_cli(self) -> bool:
        """Un agent externe (Claude Code ou agent délégué) fait le travail : pas de catalogue de modèles ni de points."""
        return self.mode == "claude" or self.mode.startswith("cli:")

    @property
    def mode_label(self) -> str:
        if self.mode == "claude":
            return "Claude Code"
        if self.mode.startswith("cli:"):
            a = get_adapter(self.mode[4:])
            return a.label if a else self.mode
        s = get_spec(self.mode)
        return s.label if s else self.mode

    def set_emit(self, fn) -> None:
        self._emit = fn
        self.agent.emit = fn
        self.claude.emit = fn
        for d in self.delegated.values():
            d.emit = fn

    def delegated_runner(self) -> DelegatedRunner:
        aid = self.mode[4:]
        if aid not in self.delegated:
            import shutil
            a = get_adapter(aid)
            if a is None:
                raise KeyError(aid)
            r = DelegatedRunner(self.config, self.budget, self.memory, self.ctx, self.session, self._emit or (lambda e: None), a, shutil.which(a.binary))
            r.ext = self.ext
            self.delegated[aid] = r
        return self.delegated[aid]

    def set_mode(self, mode: str) -> None:
        """Choisit le fournisseur : id d'API (poe, openrouter, openai…), « claude » (Claude Code) ou « cli:ID » (agent externe délégué)."""
        if mode.startswith("cli:"):
            if get_adapter(mode[4:]) is None:
                raise KeyError(mode)
        elif mode != "claude":
            spec = get_spec(mode)
            if spec is None:
                raise KeyError(mode)
            if spec.id != self.api_id:
                self.session.provider_models[self.api_id] = self.session.model
                self.provider = build_provider(spec)
                self.agent.provider = self.provider
                self.api_id = spec.id
                self.models.clear()
                self.session.model = self.session.provider_models.get(mode)
        self.session.mode = mode
        self.session.save()

    async def connect_provider(self, provider_id: str, key: str | None = None) -> tuple[bool, str]:
        """Enregistre la clé (si fournie), la vérifie auprès de l'API, puis bascule sur ce fournisseur et charge ses modèles."""
        spec = get_spec(provider_id)
        if spec is None:
            return False, f"fournisseur inconnu : {provider_id}"
        try:
            where = credentials.set_key(spec.id, key, spec.key_env) if key else None
        except credentials.KeyringUnavailable as e:
            return False, str(e)
        prov = build_provider(spec)
        ok, msg = await prov.verify()  # type: ignore[attr-defined]
        await prov.aclose()
        if not ok:
            if key:
                credentials.delete_key(spec.id)  # une clé refusée n'est pas conservée
            return False, msg
        self.set_mode(spec.id)
        await self.load_models()
        return True, f"{spec.label} connecté — {len(self.models)} modèles" + (f" (clé : {where})" if where else "")

    # ---------------------------------------------------------------- extensions / outils
    def rebuild_tools(self) -> None:
        """Outils = intégrés + skill + plugins approuvés + MCP (les modes filtrent ensuite ce que le modèle voit)."""
        t = builtin_tools()
        t["skill"] = SkillTool(lambda: self.ext.skills)
        t.update(self.ext.plugins.tools)
        t.update(self.mcp.tools())
        if self.config.fusion_enabled and self.config.fusion_helpers and self.fusion_tool is not None:
            t["ask_helper"] = self.fusion_tool  # mode fusion : consulter d'autres assistants
        self.agent.tools.clear()
        self.agent.tools.update(t)

    def reload_extensions(self) -> None:
        self.ext.reload()
        self.rebuild_tools()

    # ---------------------------------------------------------------- modes / réglages du modèle
    @property
    def runner(self):
        if self.mode == "claude":
            return self.claude
        if self.mode.startswith("cli:"):
            return self.delegated_runner()
        return self.agent

    @property
    def model_key(self) -> str:
        if self.mode == "claude":
            return "claude-code"
        if self.mode.startswith("cli:"):
            return self.mode
        return self.session.model or ""

    def model_params(self) -> list:
        if self.mode == "claude":
            return variants.claude_params()
        if self.mode.startswith("cli:"):
            return []
        m = self.models.get(self.session.model or "")
        return m.params if m else []

    def current_options(self) -> dict:
        return self.session.model_options.get(self.model_key, {})

    def set_option(self, name: str, value) -> None:
        opts = self.session.model_options.setdefault(self.model_key, {})
        if value is None:
            opts.pop(name, None)
        else:
            opts[name] = value
        self.session.save()

    def cycle_variant(self):
        r = variants.cycle(self.model_params(), self.current_options())
        if r:
            self.set_option(*r)
        return r

    def set_agent(self, name: str) -> str | None:
        """Change de mode (build, plan, personnalisé). Retourne un avertissement éventuel."""
        if name not in self.ext.modes:
            raise KeyError(name)
        self.session.agent = name
        warn = None
        pref = self.ext.modes[name].model
        if pref and not self.is_cli:
            mid = pref.split("#")[0].split("/")[-1]
            if mid in self.models:
                self.session.model = mid
            else:
                warn = f"modèle préféré du mode « {pref} » absent du catalogue"
        self.session.save()
        return warn

    def next_agent(self, step: int = 1) -> str:
        n = cycle_mode(self.ext.modes, self.session.agent, step)
        self.set_agent(n)
        return n

    # ---------------------------------------------------------------- tour utilisateur (+ annuler / rétablir)
    async def run_user_turn(self, text: str, attachments: list | None = None) -> None:
        full, _files = expand_refs(text, self.ctx.workspace.root)
        images = list(attachments or []) + [p for p in find_images(text, self.ctx.workspace.root) if p not in (attachments or [])]
        conv = self.session.conversation_id
        entry = {"text": text, "tree_before": self.snap.snapshot(), "first": self.memory.last_archive_id(conv) + 1,
                 "msgs_before": len(self.agent.messages), "mode": self.mode}
        if self.fusion_tool is not None:
            self.fusion_tool.calls = 0  # plafond de consultations : par tour
        await self.ext.plugins.fire("turn_start", {"text": text, "session": self.session.id})
        if images:
            await self.runner.run_turn(full, attachments=images)
        else:
            await self.runner.run_turn(full)
        entry["last"] = self.memory.last_archive_id(conv)
        if entry["last"] >= entry["first"]:
            entry["tree_after"] = self.snap.snapshot()
            self.session.undo_stack.append(entry)
            del self.session.undo_stack[:-50]
            self.session.redo_stack.clear()
            self.session.save()
        await self.ext.plugins.fire("turn_done", {"text": text, "session": self.session.id})

    def undo(self) -> dict | None:
        if not self.session.undo_stack:
            return None
        e = self.session.undo_stack.pop()
        touched = self.snap.restore(e["tree_before"]) if e.get("tree_before") else []
        e["undo_id"] = self.memory.mark_undone(self.session.conversation_id, e["first"], e["last"])
        e["msgs_slice"] = self.agent.messages[e["msgs_before"]:]
        del self.agent.messages[e["msgs_before"]:]
        if self.session.claude_session_id:  # la session Claude contient le tour annulé : on repart d'une nouvelle (contexte = mémoire Eclipse)
            self.session.claude_session_id = None
        self.session.redo_stack.append(e)
        self.session.save()
        return {"text": e["text"], "files": touched, "git": self.snap.available}

    def redo(self) -> dict | None:
        if not self.session.redo_stack:
            return None
        e = self.session.redo_stack.pop()
        touched = self.snap.restore(e["tree_after"]) if e.get("tree_after") else []
        self.memory.unmark_undone(e["undo_id"])
        self.agent.messages.extend(e.get("msgs_slice", []))
        self.session.undo_stack.append(e)
        self.session.save()
        return {"text": e["text"], "files": touched, "git": self.snap.available}

    async def run_shell_line(self, cmd: str):
        """`!commande` : aperçu + confirmation (mêmes règles que l'outil run_command), sortie ajoutée à la conversation comme résultat d'outil."""
        from .tools.permissions import AdminRefused
        tool = self.agent.tools["run_command"]
        try:
            req = await tool.prepare({"command": cmd}, self.ctx)
            if req is not None and not await self.ctx.permissions.authorize(req):
                return False, "refusé par l'utilisateur"
            res = await tool.run({"command": cmd}, self.ctx)
        except AdminRefused as e:
            return False, str(e)
        note = f"[Commande exécutée par l'utilisateur : {cmd}]\n{res.output}"
        self.memory.archive_message(self.session.conversation_id, "tool", f"run_command {cmd}\n{res.output}", {"tool": "run_command"})
        self.agent.messages.append({"role": "user", "content": note})  # le modèle (Poe) la voit au prochain tour
        self.claude.pending_context.append(note)  # idem pour Claude Code (préfixée au prochain tour)
        return res.ok, res.output

    def add_dir(self, path: str) -> str:
        d = self.ctx.workspace.add(path)
        if str(d) not in self.session.extra_dirs:
            self.session.extra_dirs.append(str(d))
            self.session.save()
        return str(d)

    def fork_session(self) -> Session:
        """Nouvelle session indépendante : mêmes messages récents, todo, réglages ; archives recopiées dans une nouvelle discussion."""
        import copy
        conv = self.memory.new_conversation(self.session.district_id, f"fork de {self.session.id}")
        for r in self.memory.archive_rows(self.session.conversation_id):
            self.memory.archive_message(conv, r["role"], r["content"], __import__("json").loads(r["meta"] or "{}"))
        s = Session.new(self.session.workspace, self.session.district_id, conv, self.session.model)
        for k in ("mode", "agent", "model_options", "messages", "todos", "extra_dirs", "provider_models"):
            setattr(s, k, copy.deepcopy(getattr(self.session, k)))
        s.title = (self.session.title or self.session.id) + " (fork)"
        s.save()
        return s

    def export_markdown(self) -> str:
        rows = self.memory.archive_rows(self.session.conversation_id)
        out = [f"# Session {self.session.id} — {self.ctx.workspace.root.name}", ""]
        for r in rows:
            who = {"user": "## Vous", "assistant": "## Modèle", "tool": "### Outil"}.get(r["role"], f"## {r['role']}")
            out += [who, "", r["content"], ""]
        return "\n".join(out)

    async def close(self) -> None:
        await self.bridge.stop()
        await self.mcp.close()
        await self.provider.aclose()
        self.session.save()
        self.memory.close()
        self.budget.close()


def create_services(workspace: str | Path, *, resume: str | None = None, provider: Provider | None = None,
                    asker: Asker | None = None, config: Config | None = None, memory: Memory | None = None,
                    budget: Budget | None = None) -> Services:
    cfg = config or load_config()
    mem = memory or Memory()
    bud = budget or Budget()
    prov = provider or PoeProvider()
    ws = Workspace(workspace)
    if not resume and not ws.root.is_dir():
        raise FileNotFoundError(f"dossier du projet introuvable : {ws.root}")
    if resume:
        sess = Session.load(resume)
        ws = Workspace(sess.workspace, [d for d in sess.extra_dirs if Path(d).is_dir()])
        if not ws.root.is_dir():
            raise FileNotFoundError(f"le dossier de cette session n'existe plus : {ws.root}")
        # le fil sauvegardé ne doit jamais commencer par un résultat d'outil orphelin
        while sess.messages and sess.messages[0].get("role") == "tool":
            sess.messages.pop(0)
    else:
        did = mem.ensure_district(ws.root.name, str(ws.root))
        sess = Session.new(str(ws.root), did, mem.new_conversation(did, "session"), cfg.model)
    todos = TodoList()
    todos.replace(sess.todos) if sess.todos else None
    ctx = ToolContext(workspace=ws, config=cfg, permissions=PermissionManager(asker, cfg.auto_accept_edits), todos=todos,
                      cancel=asyncio.Event(), memory=mem, district_id=sess.district_id, conversation_id=sess.conversation_id,
                      cache=WorkingCache())
    mcp = McpManager(load_mcp_config(cfg.mcp_config))
    agent = Agent(prov, cfg, bud, mem, ctx, builtin_tools(), sess, {}, lambda e: None)
    bridge = EclipseBridge(lambda: agent)
    claude = ClaudeCodeRunner(cfg, bud, mem, ctx, sess, lambda e: None, bridge)
    ext = Extensions(ws.root)
    sv = Services(cfg, mem, bud, prov, sess, ctx, agent, mcp, claude, bridge, ext, Snapshots(ws.root))
    if sess.mode not in ("claude",) and not sess.mode.startswith("cli:"):
        sv.api_id = sess.mode
        if provider is None and sess.mode != "poe" and get_spec(sess.mode):
            sv.provider = agent.provider = build_provider(get_spec(sess.mode))
    agent.models = sv.models
    agent.ext = ext
    sv.fusion_tool = FusionTool(bud, lambda: sess.id, lambda: sv.config)
    claude.ext = ext
    sv.rebuild_tools()
    return sv
