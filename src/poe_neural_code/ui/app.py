"""Eclipse — terminal principal (Textual). Accueil, session à blocs, aperçu des commandes, toutes les commandes OpenCode."""
from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from rich.align import Align
from rich.console import Group
from rich.table import Table
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.command import Hit, Hits, Provider
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import Input, Label, OptionList, Static, TabbedContent, TabPane, TextArea
from textual.widgets.option_list import Option

from .. import __version__, credentials, variants
from ..cli_agents import detect, find_binary, get_adapter
from .. import fusion as F
from ..providers import ProviderSpec, all_specs, get_spec, has_credentials, save_custom
from ..agent import (AssistantDelta, AssistantMessage, CgProgress, DiffShown, Paused, StatusEvent, ThinkingEvent, ToolFinished, ToolRequested, TurnDone, UsageEvent)
from ..config import load_config, save_config
from ..extensions import commands as C
from ..extensions.refs import fuzzy, list_files
from ..memory.engine import estimate_tokens
from ..memory.compaction import compact_segment, synthesize_district, verify_summary
from ..paths import data_dir
from ..services import Services, create_services
from ..session import list_sessions
from ..tools.permissions import PermissionRequest
from .modals import (ConfirmScreen, DefineTokenScreen, InfoScreen, PermissionScreen, PickerScreen, TextPromptScreen, help_table, keys_table)
from .panels import render_claude, render_context, render_ext, render_files, render_header, render_todo, render_tools_tab, render_usage
from .theme import CUSTOM
from .util import parse_duration
from . import icons as I
from .. import platform_compat as PC
from .bars import bar
from .widgets import AssistantAnswer, DiffBlock, NoticeLine, PromptArea, ThinkingBlock, ToolBlock, TurnFooter, UserBubble, WelcomeCard

LOGO = r"""
 ███████╗ ██████╗██╗     ██╗██████╗ ███████╗███████╗
 ██╔════╝██╔════╝██║     ██║██╔══██╗██╔════╝██╔════╝
 █████╗  ██║     ██║     ██║██████╔╝███████╗█████╗
 ██╔══╝  ██║     ██║     ██║██╔═══╝ ╚════██║██╔══╝
 ███████╗╚██████╗███████╗██║██║     ███████║███████╗
 ╚══════╝ ╚═════╝╚══════╝╚═╝╚═╝     ╚══════╝╚══════╝"""
from ..extensions.commands import INIT_PROMPT  # noqa: E402  (partagé avec le desktop)
CLAUDE_ALIASES = ["haiku", "sonnet", "opus"]
LEADER_KEYS = {"p": "permissions", "i": "usage", "n": "new", "l": "sessions", "m": "models", "t": "themes", "b": "sidebar", "e": "editor", "x": "export", "c": "compact", "u": "undo",
               "r": "redo", "a": "agents", "g": "timeline", "h": "details", "y": "copy", "q": "exit", "s": "status"}
MODE_COLORS = {"build": "#a78bfa", "plan": "#fbbf24"}


def tool_summary(name: str, a: dict) -> str:
    """Résumé lisible d'un appel d'outil (pas de JSON brut)."""
    if name == "todo_write":
        items = a.get("items") or []
        done = sum(1 for i in items if i.get("status") == "done")
        return f"{len(items)} tâche(s), {done} terminée(s)"
    if name == "search_files":
        return f"« {a.get('pattern', '')} »" + (f" dans {a['glob']}" if a.get("glob") else "")
    if name in ("memory_search",):
        return f"« {a.get('query', '')} »"
    if name == "memory_note":
        return f"{a.get('kind', '')} : {str(a.get('content', ''))[:60]}"
    if name == "ask_helper":
        return f"{a.get('helper', '')} ← {str(a.get('prompt', ''))[:60]}"
    for k in ("command", "path", "url", "ref", "name", "helper"):
        if a.get(k):
            return str(a[k])
    return ", ".join(f"{k}={str(v)[:30]}" for k, v in a.items())


def git_branch(root: Path) -> str | None:
    try:
        r = subprocess.run(["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, timeout=3)
        return r.stdout.strip() or None if r.returncode == 0 else None
    except Exception:  # noqa: BLE001
        return None


# ======================================================================= accueil
class HomeScreen(Screen):
    DEFAULT_CSS = """
    HomeScreen { align: center middle; }
    #home { width: 100; max-width: 96%; height: auto; max-height: 100%; }
    #logo { color: $primary; text-style: bold; content-align: center middle; width: 100%; margin-bottom: 1; }
    #tag { color: $text-muted; content-align: center middle; width: 100%; margin-bottom: 1; }
    #home Input { border: round $primary; margin: 0 4; }
    #home-sessions-title { margin: 1 4 0 4; color: $text-muted; }
    #sessions { height: 9; margin: 0 4; background: transparent; border: none; }
    #detected { color: $secondary; margin: 1 4 0 4; content-align: center middle; width: 100%; }
    #tips { color: $text-muted; margin: 1 4 0 4; content-align: center middle; width: 100%; }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="home"):
            yield Static(Text(LOGO), id="logo")
            yield Static("agent de programmation · mémoire persistante · budget local  —  nom de code POE · Neural Code", id="tag")
            yield Input(value=os.getcwd(), placeholder="Dossier du projet à ouvrir", id="path")
            yield Label("Reprendre une session", id="home-sessions-title")
            opts = [Option(Text.assemble((f"{s.id}", "bold"), f"  {datetime.fromtimestamp(s.updated):%d/%m %H:%M}  ", (Path(s.workspace).name, "cyan"),
                                         f"  {s.model or s.mode}"), id=s.id) for s in list_sessions()[:30]]
            yield OptionList(*(opts or [Option(Text("(aucune session)", style="dim"), disabled=True)]), id="sessions")
            det = [d.adapter.label for d in detect() if d.installed]
            yield Static("Agents IA détectés : " + (", ".join(det) if det else "aucun") + "  ·  /connect pour brancher un agent ou une clé d'API", id="detected")
            yield Static("Entrée ouvre le dossier · /help dans une session · Ctrl+P palette · Ctrl+X leader · Ctrl+Q quitter", id="tips")

    def on_mount(self) -> None:
        self.query_one("#path", Input).focus()

    def on_input_submitted(self, e: Input.Submitted) -> None:
        p = Path(e.value).expanduser()
        if not p.is_dir():
            self.notify(f"Dossier introuvable : {p}", severity="error")
            return
        self.app.open_project(str(p), None)

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        if e.option.id:
            self.app.open_project(None, e.option.id)


# ======================================================================= session
class WorkScreen(Screen):
    DEFAULT_CSS = """
    #topbar { height: 1; background: $panel; color: $text; padding: 0 1; }
    #body { height: 1fr; }
    #main { width: 1fr; }
    #chat { height: 1fr; padding: 0 1; scrollbar-size-vertical: 1; }
    #working { height: 1; padding: 0 2; color: $warning; display: none; }
    #working.show { display: block; }
    #composer { height: auto; margin: 0 1; }
    #preview { height: auto; max-height: 12; display: none; background: $panel; border: round $primary 50%; }
    #preview.show { display: block; }
    #modeline { padding: 0 1; height: 1; color: $text-muted; }
    #hints { padding: 0 2; height: 1; color: $text-muted; background: $panel; }
    #sidebar { width: 48; background: $surface; border-left: tall $primary 30%; }
    #sidebar.hidden { display: none; }
    #sidebar TabPane { padding: 0 1; }
    #sb-head, #context, #todo, #files, #ext { height: auto; margin-bottom: 1; }
    #usage { height: auto; }
    """
    BINDINGS = [
        Binding("escape", "interrupt", "Interrompre", show=False),
        Binding("ctrl+b", "toggle_sidebar", "Barre latérale", show=False),
        Binding("ctrl+x", "leader", "Leader", priority=True, show=False),
        Binding("ctrl+c", "clear_or_exit", "Vider/quitter", priority=True, show=False),
        Binding("ctrl+t", "cycle_variant", "Effort", priority=True, show=False),
        Binding("f2", "cycle_model", "Modèle suivant", priority=True, show=False),
        Binding("tab", "tab", "Mode", priority=True, show=False),
        Binding("shift+tab", "cycle_agent(-1)", "Mode précédent", priority=True, show=False),
        Binding("pageup", "scroll_chat(-1)", "Haut", priority=True, show=False),
        Binding("pagedown", "scroll_chat(1)", "Bas", priority=True, show=False),
        Binding("up", "preview_move(-1)", "↑", priority=True, show=False),
        Binding("down", "preview_move(1)", "↓", priority=True, show=False),
        Binding("ctrl+r", "rename", "Renommer", priority=True, show=False),
    ]
    SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, sv: Services):
        super().__init__()
        self.sv = sv
        self.busy = False
        self.show_sidebar = sv.config.sidebar_visible
        self.show_thinking = False
        self.show_details = True
        self.live_answer: AssistantAnswer | None = None
        self.live_think: ThinkingBlock | None = None
        self.tool_blocks: dict[str, ToolBlock] = {}
        self.modified: dict[str, str] = {}
        self.user_bubbles: list[UserBubble] = []
        self.leader_active = False
        self.leader_keys = LEADER_KEYS
        self._leader_timer = None
        self._exit_armed = 0.0
        self._files_cache: list[str] | None = None
        self._preview_items: list[tuple[str, str]] = []
        self._preview_mode = ""
        self._turn_t0 = 0.0
        self._turn_tot0: dict | None = None
        self._activity = ""
        self._spin = 0
        self.pending_attachments: list[Path] = []
        self.branch = git_branch(sv.ctx.workspace.root)

    # ------------------------------------------------------------ mise en page
    def compose(self) -> ComposeResult:
        yield Static("", id="topbar")
        with Horizontal(id="body"):
            with Vertical(id="main"):
                yield VerticalScroll(id="chat")
                yield Static("", id="working")
                with Vertical(id="composer"):
                    yield OptionList(id="preview")
                    yield PromptArea(placeholder="Votre instruction…  ·  /commandes  ·  @fichier  ·  !shell  ·  Maj+Entrée : nouvelle ligne", id="prompt")
                    yield Static("", id="modeline")
            with TabbedContent("Session", "Conso", "Outils", id="sidebar"):
                with TabPane("Session", id="tab-session"):
                    with VerticalScroll():
                        yield Static("", id="sb-head")
                        yield Static("", id="context")
                        yield Static("", id="todo")
                        yield Static("", id="files")
                with TabPane("Conso", id="tab-usage"):
                    with VerticalScroll():
                        yield Static("", id="usage")
                with TabPane("Outils", id="tab-tools"):
                    with VerticalScroll():
                        yield Static("", id="ext")
        yield Static("", id="hints")

    async def on_mount(self) -> None:
        sv = self.sv
        sv.set_emit(self.handle_agent_event)
        sv.ctx.permissions.asker = self.ask_permission
        sv.ctx.todos.on_change = self.refresh_panels
        self.query_one("#sidebar").set_class(not self.show_sidebar, "hidden")
        chat = self.query_one("#chat", VerticalScroll)
        chat.can_focus = False
        prompt = self.query_one("#prompt", PromptArea)
        prior = sv.memory.q("SELECT role, content FROM archive WHERE conversation_id=? ORDER BY id DESC LIMIT 12", (sv.session.conversation_id,))[::-1]
        prompt.prompt_history = [r["content"].split("\n\n--- Fichier")[0] for r in prior if r["role"] == "user"][-50:]
        if prior:
            await chat.mount(NoticeLine(f"{I.get('session')} Reprise de la session {sv.session.title or sv.session.id} — {len(prior)} derniers échanges :", "info"))
            for r in prior:
                if r["role"] in ("user", "assistant"):
                    await chat.mount(NoticeLine(f"  {'vous' if r['role'] == 'user' else 'modèle'} › {' '.join(r['content'].split())[:150]}", "info"))
        else:
            await chat.mount(WelcomeCard(self.welcome()))
        if not sv.is_cli and not sv.provider.configured():
            await chat.mount(NoticeLine(f"{I.get('warn')} {sv.mode_label} : connexion non configurée — tapez /connect (clé d'API ou agent installé) ou /free pour les modèles gratuits. "
                                        "Aucune réponse n'est simulée.", "warn"))
        self.refresh_panels()
        self.set_interval(1.0, self.refresh_panels)
        self.set_interval(0.12, self._tick)
        self.run_worker(self._startup(), exclusive=False)
        prompt.focus()

    def welcome(self) -> Group:
        sv = self.sv
        t = Text()
        t.append(f"{I.get('eclipse')} ECLIPSE ", style="bold #a78bfa")
        t.append(f"{__version__}  ·  ", style="dim")
        t.append(f"{sv.ctx.workspace.root}", style="cyan")
        if self.branch:
            t.append(f"  {I.get('branch')} {self.branch}", style="magenta")
        t.append("\n\n")
        ok = sv.is_cli or sv.provider.configured()
        t.append("Fournisseur  ", style="dim")
        t.append(f"{sv.mode_label}", style="bold")
        t.append(f"  {I.get('ok')} prêt\n" if ok else f"  {I.get('error')} non connecté\n", style="green" if ok else "yellow")
        t.append("Modèle       ", style="dim")
        t.append(f"{sv.session.model or (sv.config.claude_model if sv.mode == 'claude' else None) or 'à choisir (/models)'}\n")
        t.append("Mode         ", style="dim")
        t.append(f"{sv.session.agent}   ·   permissions {sv.ctx.permissions.mode}\n\n")
        tips = Table(show_header=False, box=None, padding=(0, 2))
        for k, d in (("/connect", "brancher un agent installé ou une clé d'API"), ("/free", "modèles gratuits"), ("/models  /effort", "choisir le modèle et son effort"),
                     ("@fichier  !commande", "joindre un fichier · lancer une commande"), ("Tab", "build ⇄ plan (lecture seule)"), ("/help  Ctrl+P", "toutes les commandes")):
            tips.add_row(Text(k, style="bold #a78bfa"), Text(d, style="dim"))
        return Group(t, tips)

    async def _startup(self) -> None:
        await self.sv.load_models()
        if not self.sv.session.model and not self.sv.is_cli:
            self.toast("Aucun modèle choisi : /models", "warning")
        await self.sv.start_mcp()
        self.refresh_panels()

    # ------------------------------------------------------------ rendu
    def chat(self) -> VerticalScroll:
        return self.query_one("#chat", VerticalScroll)

    def prompt(self) -> PromptArea:
        return self.query_one("#prompt", PromptArea)

    def add(self, widget) -> None:
        chat = self.chat()
        for w in list(chat.query(WelcomeCard)):
            w.remove()  # la carte d'accueil disparaît au premier échange
        chat.mount(widget)
        chat.scroll_end(animate=False)

    def note(self, text: str, level: str = "info") -> None:
        self.add(NoticeLine(text, level))

    def toast(self, text: str, severity: str = "information") -> None:
        """Confirmation brève (réglage changé…) : notification qui disparaît, sans encombrer la conversation."""
        self.app.notify(text, severity=severity, timeout=3)  # type: ignore[arg-type]

    def log_line(self, text: str, style: str = "") -> None:  # compat
        self.note(text, "warn" if style in ("yellow", "red") else "info")

    def modeline(self) -> Text:
        sv = self.sv
        mode = sv.session.agent
        t = Text()
        t.append(f" ▌{mode.upper()} ", style=f"bold {MODE_COLORS.get(mode, '#22d3ee')}")
        if sv.mode == "claude":
            t.append(f"Claude Code · {sv.config.claude_model or 'défaut'}")
        elif sv.is_cli:
            t.append(f"{sv.mode_label} (délégué) · {sv.config.cli_models.get(sv.mode[4:]) or 'modèle de l\'agent'}")
        else:
            t.append(f"{sv.mode_label} · {sv.session.model or 'aucun modèle'}")
            m = sv.models.get(sv.session.model or "")
            if m is not None and m.free:
                t.append(" · gratuit", style="#4ade80")
        s = variants.summary(sv.model_params(), sv.current_options())
        if s:
            t.append(f"  ·  {s}", style="#f0abfc")
        pm = sv.ctx.permissions
        if pm.mode == "bypass":
            t.append(f"  ·  {I.get('bypass')} BYPASS" + (" TOTAL" if pm.bypass_all else ""), style="bold #f87171")
        elif pm.mode == "edits":
            t.append(f"  ·  {I.get('edit')} modifications auto", style="#fbbf24")
        if self.pending_attachments:
            t.append(f"  ·  {I.get('attach')} {len(self.pending_attachments)}", style="#22d3ee")
        try:
            txt = self.prompt().text
            if txt.strip():
                t.append(f"  ·  ≈ {estimate_tokens(txt):,} tok".replace(",", " "), style="dim")
        except Exception:  # noqa: BLE001
            pass
        if sv.session.undo_stack:
            t.append(f"  ·  {I.get('undo')} {len(sv.session.undo_stack)}", style="dim")
        return t

    def topbar(self) -> Text:
        sv = self.sv
        t = Text()
        t.append(f" {I.get('eclipse')} ECLIPSE ", style="bold #a78bfa")
        t.append(f"│ {sv.ctx.workspace.root.name}", style="cyan")
        if self.branch:
            t.append(f" {I.get('branch')} {self.branch}", style="magenta")
        t.append(f" │ {sv.mode_label}", style="bold")
        if not sv.is_cli:
            t.append(f" · {sv.session.model or '—'}")
        t.append(f" │ {sv.session.agent.upper()}", style=MODE_COLORS.get(sv.session.agent, "#22d3ee"))
        if sv.ctx.permissions.mode == "bypass":
            t.append(f" │ {I.get('bypass')} BYPASS", style="bold #f87171")
        used = getattr(sv.runner, "last_ctx_tokens", 0) or 0
        if not sv.is_cli and used:
            win = sv.agent.window()
            t.append(" │ ctx ")
            t.append_text(bar(used / win if win else None, 8))
            t.append(f" {used / win * 100:.0f} %" if win else "")
        tot = sv.budget.totals(0, session_id=sv.session.id)
        n = sum(tot["tokens_in"].values()) + sum(tot["tokens_out"].values())
        if n:
            t.append(f" │ session {n:,} tok".replace(",", " "), style="dim")
            pts = sum(tot["points"].values())
            if pts and sv.mode == "poe":
                t.append(f" · {pts:,.0f} pts".replace(",", " "), style="dim")
            elif tot["usd"]:
                t.append(f" · ${tot['usd']:.3f}", style="dim")
        return t

    def refresh_panels(self) -> None:
        sv = self.sv
        try:
            self.query_one("#topbar", Static).update(self.topbar())
            self.query_one("#sb-head", Static).update(render_header(sv, self.branch))
            self.query_one("#context", Static).update(render_context(sv))
            self.query_one("#todo", Static).update(render_todo(sv.ctx.todos))
            self.query_one("#files", Static).update(render_files(self.modified))
            self.query_one("#ext", Static).update(render_tools_tab(sv))
            self.query_one("#usage", Static).update(render_usage(sv.budget, sv.config, sv.models.get(sv.session.model or ""), sv.session.model,
                                                                 sv.session.id, sv.agent.session_tokens, mode=sv.mode, claude_info=sv.claude.info, compact=True))
            self.query_one("#modeline", Static).update(self.modeline())
            if self.leader_active:
                hint = Text("LEADER : n nouvelle · l sessions · m modèles · t thèmes · b barre · e éditeur · x export · c compacter · u undo · r redo · a modes · p permissions · i usage · s état",
                            style="bold #fbbf24")
            else:
                hint = Text(("Échap interrompre" if self.busy else "Entrée envoyer · Maj+Entrée ligne") +
                            "  ·  Tab mode  ·  Ctrl+T effort  ·  Ctrl+P commandes  ·  Ctrl+X leader  ·  /help", style="dim")
            self.query_one("#hints", Static).update(hint)
        except Exception:  # noqa: BLE001 — écran en cours de fermeture
            pass

    def _tick(self) -> None:
        w = self.query_one("#working", Static)
        w.set_class(self.busy, "show")
        if not self.busy:
            return
        self._spin = (self._spin + 1) % len(self.SPINNER)
        el = time.time() - self._turn_t0
        w.update(Text.assemble((f"{self.SPINNER[self._spin]} ", "bold #fbbf24"), (f"{self._activity or 'réflexion'}…", "#fbbf24"),
                               (f"  {el:4.1f} s  ·  Échap pour interrompre", "dim")))

    def on_resize(self, event) -> None:
        self.query_one("#sidebar").set_class(not self.show_sidebar or event.size.width < 100, "hidden")

    def action_toggle_sidebar(self) -> None:
        self.show_sidebar = not self.show_sidebar
        self.query_one("#sidebar").set_class(not self.show_sidebar, "hidden")
        self.sv.config.sidebar_visible = self.show_sidebar
        save_config(self.sv.config)

    def action_interrupt(self) -> None:
        if self.busy:
            self.sv.interrupt_cg()
            self.sv.agent.interrupt()
            self.sv.claude.interrupt()
            self._activity = "interruption"
            self.note(f"{I.get('stop')} interruption demandée…", "warn")

    # ------------------------------------------------------------ événements de l'agent
    def handle_agent_event(self, e) -> None:
        if isinstance(e, AssistantDelta):
            self._activity = "rédaction"
            if self.live_answer is None:
                self.live_answer = AssistantAnswer("")
                self.add(self.live_answer)
            self.live_answer.append(e.text)
            self.chat().scroll_end(animate=False)
        elif isinstance(e, AssistantMessage):
            text = f"**{e.author} · {e.phase}**\n\n{e.text}" if e.author else e.text
            if self.live_answer is not None:
                self.live_answer.finish(text)
            else:
                self.add(AssistantAnswer(text))
            self.live_answer = None
            self.live_think = None
        elif isinstance(e, CgProgress):
            self._activity = e.text
        elif isinstance(e, ThinkingEvent):
            self._activity = "réflexion"
            if self.live_think is None:
                self.live_think = ThinkingBlock()
                self.live_think.set_class(self.show_thinking, "visible")
                self.add(self.live_think)
            self.live_think.append(e.text)
        elif isinstance(e, ToolRequested):
            self.live_answer = None
            self._activity = f"outil {e.name}"
            summ = tool_summary(e.name, e.args)
            b = ToolBlock(e.name, str(summ))
            if not self.show_details:
                b.details = False
            self.tool_blocks[e.id] = b
            if e.name in ("write_file", "edit_file"):
                self.modified[e.args.get("path", "?")] = "write"
            elif e.name == "delete_file":
                self.modified[e.args.get("path", "?")] = "delete"
            self.add(b)
        elif isinstance(e, ToolFinished):
            b = self.tool_blocks.pop(e.id, None)
            if b is None:
                b = ToolBlock(e.name, "")
                self.add(b)
            b.finish(e.ok, e.output)
            self._activity = "réflexion"
            self.chat().scroll_end(animate=False)
        elif isinstance(e, DiffShown):
            self.add(DiffBlock(e.diff))
        elif isinstance(e, StatusEvent):
            self.note((I.get("warn") + " " if e.level != "info" else I.get("info") + " ") + e.text, {"info": "info", "warn": "warn", "error": "error"}[e.level])
        elif isinstance(e, Paused):
            self.live_answer = None
            self.note(I.get("pause") + " " + e.reason, "error")
        elif isinstance(e, TurnDone):
            self._turn_done(e.interrupted, e.failed)
        if isinstance(e, (UsageEvent, TurnDone, Paused, ToolFinished)):
            self.refresh_panels()

    def _turn_done(self, interrupted: bool, failed: bool) -> None:
        self.busy = False
        self.live_answer = self.live_think = None
        self._activity = ""
        el = time.time() - self._turn_t0 if self._turn_t0 else 0
        t0 = self._turn_tot0
        if t0 is not None:
            t1 = self.sv.budget.totals(0, session_id=self.sv.session.id)
            dm = {k: t1["tokens_in"][k] - t0["tokens_in"][k] + t1["tokens_out"][k] - t0["tokens_out"][k] for k in ("measured", "estimated")}
            din = sum(t1["tokens_in"].values()) - sum(t0["tokens_in"].values())
            dout = sum(t1["tokens_out"].values()) - sum(t0["tokens_out"].values())
            nature = "mesurés" if dm["measured"] and not dm["estimated"] else ("estimés" if dm["estimated"] and not dm["measured"] else "mesurés + estimés")
            if failed:
                label, color = I.get("error") + " Échec", "#f87171"
            elif interrupted:
                label, color = I.get("stop") + " interrompu", "#fbbf24"
            else:
                label, color = I.get("ok"), "#4ade80"
            txt = Text(f"{label}  {el:.1f} s", style=color)
            if din or dout:
                txt.append(f"  ·  ↓{din:,} ↑{dout:,} tok [{nature}]".replace(",", " "), style="dim")
            dp = {k: t1["points"][k] - t0["points"][k] for k in t1["points"]}
            if dp.get("estimated"):
                txt.append(f"  ·  ≈ {dp['estimated']:.1f} pts [estimé]", style="dim")
            if t1["usd"] - t0["usd"] > 0:
                txt.append(f"  ·  ≈ ${t1['usd'] - t0['usd']:.4f}", style="dim")
            self.add(TurnFooter(txt))
        self._turn_tot0 = None
        if el >= self.sv.config.notify_after_s:
            self.app.bell()
            if self.sv.config.desktop_notify and shutil.which("notify-send"):
                subprocess.Popen(["notify-send", "Eclipse", f"Tour terminé en {el:.0f} s"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    async def ask_permission(self, req: PermissionRequest) -> str:
        d = await self.app.push_screen_wait(PermissionScreen(req))
        self.note({"once": "→ autorisé (une fois)", "session": "→ autorisé (session)", "deny": "→ refusé"}[d], "ok" if d != "deny" else "warn")
        return d

    # ------------------------------------------------------------ aperçu des commandes / fichiers pendant la frappe
    POINTS_COMMANDS = ("define-token", "rate", "spent")

    def _commands(self) -> list[C.Command]:
        cmds = self.sv.ext.commands()
        if self.sv.is_cli:  # abonnement (Claude Code, Codex…) : c'est lui qui gère la consommation, pas les budgets en points d'Eclipse
            cmds = [c for c in cmds if c.name not in self.POINTS_COMMANDS]
        return cmds

    def on_text_area_changed(self, e: TextArea.Changed) -> None:
        if getattr(e.text_area, "id", None) != "prompt":
            return
        self._update_preview(e.text_area.text)
        try:
            self.query_one("#modeline", Static).update(self.modeline())
        except Exception:  # noqa: BLE001
            pass

    def _update_preview(self, v: str) -> None:
        prev = self.query_one("#preview", OptionList)
        items: list[tuple[str, Text]] = []
        mode = ""
        if v.startswith("/") and " " not in v and "\n" not in v:
            mode = "cmd"
            for c in C.preview(v, self._commands()):
                t = Text.assemble((f"/{c.name}", "bold #a78bfa"), (f"  {c.description[:72]}", "dim"), (f"   {c.keybind}" if c.keybind else "", "#f0abfc"))
                items.append((f"/{c.name} ", t))
        elif v.startswith("!"):
            mode = "shell"
            cmd = v[1:].strip()
            if cmd:
                items.append(("", Text.assemble((I.get("terminal") + " commande shell : ", "bold #fbbf24"), (cmd[:120], "bold"), ("   (aperçu + confirmation avant exécution)", "dim"))))
        else:
            tok = v.rsplit(None, 1)[-1] if v.strip() else ""
            if tok.startswith("@") and not v.endswith((" ", "\n")):
                mode = "file"
                if self._files_cache is None:
                    self._files_cache = list_files(self.sv.ctx.workspace.root)
                for f in fuzzy(self._files_cache, tok[1:], 8):
                    icon = (I.get("image") + " ") if Path(f).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".gif") else (I.get("file") + " ")
                    items.append((v[: len(v) - len(tok)] + f"@{f} ", Text.assemble((icon + "@" + f, "bold #22d3ee"))))
        self._preview_items, self._preview_mode = items, mode
        prev.clear_options()
        for _, t in items:
            prev.add_option(Option(t))
        prev.set_class(bool(items), "show")
        if items:
            prev.highlighted = 0

    def preview_visible(self) -> bool:
        return self.query_one("#preview", OptionList).has_class("show") and bool(self._preview_items)

    def check_action(self, action: str, parameters) -> bool | None:
        if action == "preview_move":
            return self.preview_visible() and self._preview_mode in ("cmd", "file")
        return True

    def action_preview_move(self, step: int) -> None:
        ol = self.query_one("#preview", OptionList)
        n = len(self._preview_items)
        if n:
            ol.highlighted = ((ol.highlighted or 0) + step) % n

    def _accept_preview(self) -> bool:
        if not (self.preview_visible() and self._preview_mode in ("cmd", "file")):
            return False
        i = self.query_one("#preview", OptionList).highlighted or 0
        self.prompt().value = self._preview_items[i][0]
        return True

    def action_tab(self) -> None:
        if not self._accept_preview():
            self.action_cycle_agent(1)

    # ------------------------------------------------------------ touches
    def action_leader(self) -> None:
        self.leader_active = True
        if self._leader_timer:
            self._leader_timer.stop()
        self._leader_timer = self.set_timer(2.0, self._leader_off)
        self.refresh_panels()

    def _leader_off(self) -> None:
        self.leader_active = False
        self.refresh_panels()

    def action_leader_do(self, key: str) -> None:
        self._leader_off()
        if self._leader_timer:
            self._leader_timer.stop()
        self.run_worker(self.run_slash("/" + LEADER_KEYS[key]), exclusive=False)

    def action_clear_or_exit(self) -> None:
        p = self.prompt()
        if p.text:
            p.value = ""
        elif time.time() - self._exit_armed < 2:
            self.app.exit()
        else:
            self._exit_armed = time.time()
            self.toast("Ctrl+C encore une fois pour quitter.", "warning")

    def action_scroll_chat(self, d: int) -> None:
        self.chat().scroll_page_down(animate=False) if d > 0 else self.chat().scroll_page_up(animate=False)

    def action_cycle_agent(self, step: int) -> None:
        n = self.sv.next_agent(step)
        self.note(f"Mode → {n}" + (f" — {self.sv.ext.modes[n].description}" if self.sv.ext.modes[n].description else ""), "ok")
        self.refresh_panels()

    def action_cycle_variant(self) -> None:
        r = self.sv.cycle_variant()
        if r is None:
            self.toast("Ce modèle ne propose pas de réglage d'effort (voir /options).", "warning")
        else:
            self.toast(f"{r[0]} → {r[1] if r[1] is not None else 'défaut du modèle'}")
        self.refresh_panels()

    def action_cycle_model(self) -> None:
        sv = self.sv
        if sv.is_cli and sv.mode != "claude":
            self.toast("Le modèle d'un agent délégué se règle avec /model.", "warning")
            return
        pool = CLAUDE_ALIASES if sv.mode == "claude" else [m for m in sv.config.recent_models if m in sv.models]
        if not pool:
            self.toast("Aucun modèle récent : /models.", "warning")
            return
        cur = sv.config.claude_model if sv.mode == "claude" else sv.session.model
        nxt = pool[(pool.index(cur) + 1) % len(pool)] if cur in pool else pool[0]
        self._set_model(nxt)

    def action_rename(self) -> None:
        self.run_worker(self.run_slash("/rename"), exclusive=False)

    # ------------------------------------------------------------ saisie
    async def on_prompt_area_submitted(self, e: PromptArea.Submitted) -> None:
        v = e.value
        text = v.strip()
        if self._preview_mode in ("cmd", "file") and self.preview_visible():
            i = self.query_one("#preview", OptionList).highlighted or 0
            target = self._preview_items[i][0].strip()
            if self._preview_mode == "file":
                if not v.rstrip().endswith(target.rsplit(None, 1)[-1]):
                    self._accept_preview()
                    return
            elif v.startswith("/") and " " not in v and not C.resolve(v.lstrip("/").strip().lower(), self._commands()):
                self._accept_preview()
                text = self.prompt().text.strip()
        p = self.prompt()
        p.remember(text)
        p.value = ""
        self._update_preview("")
        if not text:
            return
        if text.startswith("/"):
            self.run_worker(self.run_slash(text), exclusive=False)
        elif text.startswith("!"):
            self.run_worker(self.run_shell(text[1:].strip()), exclusive=False)
        else:
            await self.submit(text)

    async def submit(self, text: str, shown: str | None = None) -> None:
        if self.busy:
            self.toast("Un tour est en cours (Échap pour interrompre).", "warning")
            return
        self.busy = True
        self._turn_t0 = time.time()
        self._turn_tot0 = self.sv.budget.totals(0, session_id=self.sv.session.id)
        self._activity = "envoi"
        att = list(self.pending_attachments)
        self.pending_attachments.clear()
        b = UserBubble((shown or text) + "".join(f"\n{I.get('attach')} {a.name}" for a in att))
        self.user_bubbles.append(b)
        self.add(b)
        self.refresh_panels()
        self.run_worker(self.sv.run_user_turn(text, attachments=att or None), exclusive=False)

    async def run_shell(self, cmd: str) -> None:
        if not cmd:
            return
        b = ToolBlock("run_command", cmd)
        self.add(b)
        ok, out = await self.sv.run_shell_line(cmd)
        b.finish(ok, out)
        self.refresh_panels()

    # ------------------------------------------------------------ sélecteurs
    def _set_model(self, name: str) -> None:
        sv = self.sv
        if sv.mode == "claude":
            sv.config.claude_model = None if name in ("", "défaut") else name
            save_config(sv.config)
            self.toast(f"Modèle Claude Code → {sv.config.claude_model or 'défaut'}")
        elif sv.is_cli:
            aid = sv.mode[4:]
            if name in ("", "défaut"):
                sv.config.cli_models.pop(aid, None)
            else:
                sv.config.cli_models[aid] = name
            save_config(sv.config)
            self.note(f"Modèle {sv.mode_label} → {sv.config.cli_models.get(aid, 'défaut de l\'agent')} (transmis à l'option de l'agent)", "ok")
        else:
            m = sv.models.get(name)
            sv.session.model = name
            sv.config.model = name
            sv.config.recent_models = [name] + [x for x in sv.config.recent_models if x != name][:7]
            save_config(sv.config)
            extra = ""
            if m and variants.effort_param(m.params):
                extra = " · Ctrl+T pour l'effort"
            if m and not m.supports_tools:
                self.note(I.get("warn") + " ce modèle n'annonce pas les appels d'outils : l'agent ne pourra pas agir.", "warn")
            self.toast(f"Modèle → {name}{extra}")
        self.refresh_panels()

    async def pick_model(self, free_only: bool = False) -> None:
        sv = self.sv
        if sv.is_cli and sv.mode != "claude":
            items: list = []
            if sv.mode == "cli:opencode":  # liste réelle des modèles d'OpenCode (gratuits en tête)
                self.toast("Lecture des modèles d'OpenCode…")
                exe = find_binary("opencode", sv.config)
                try:
                    proc = await asyncio.create_subprocess_exec(exe, "models", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    out, _ = await asyncio.wait_for(proc.communicate(), 40)
                    names = [l.strip() for l in out.decode(errors="replace").splitlines() if l.strip()]
                except Exception:  # noqa: BLE001
                    names = []
                names.sort(key=lambda n: (not n.endswith("-free"), n))
                items = [("défaut de l'agent", "défaut", "")] + [(n, n, "gratuit" if n.endswith("-free") else "") for n in names
                                                                  if not free_only or n.endswith("-free")]
            if len(items) > 1:
                v = await self.app.push_screen_wait(PickerScreen(f"Modèles {sv.mode_label}", items, current=sv.config.cli_models.get(sv.mode[4:], "défaut")))
            else:
                v = await self.app.push_screen_wait(TextPromptScreen(f"Modèle pour {sv.mode_label} (vide = défaut de l'agent ; format propre à l'agent)",
                                                                     sv.config.cli_models.get(sv.mode[4:], "")))
            if v is not None:
                self._set_model(v or "défaut")
            return
        if sv.mode == "claude":
            items = [("défaut", "défaut", "modèle par défaut de Claude Code")] + [(a, a, "alias Claude Code") for a in CLAUDE_ALIASES] + [("autre…", "__custom__", "saisir un identifiant")]
            v = await self.app.push_screen_wait(PickerScreen("Modèle Claude Code", items, current=sv.config.claude_model or "défaut"))
            if v == "__custom__":
                v = await self.app.push_screen_wait(TextPromptScreen("Identifiant du modèle (--model)"))
            if v:
                self._set_model(v)
            return
        if not sv.models:
            await sv.load_models()
        ms = [m for m in sv.models.values() if m.chat_text and m.supports_tools and (m.free or not free_only)]
        if not ms:
            self.note(f"Catalogue {sv.mode_label} indisponible ou vide (clé ? réseau ? /connect)" + (" — aucun modèle gratuit avec outils" if free_only else "") + ".", "warn")
            return
        fav = set(sv.config.favorite_models)
        rec = {m: i for i, m in enumerate(sv.config.recent_models)}

        def det(m):
            price = "gratuit" if m.free else (f"${m.prompt_price * 1e6:.2f}/${m.completion_price * 1e6:.2f} /Mtok" if m.prompt_price is not None else "prix indisponible")
            ef = variants.effort_param(m.params)
            return (f"ctx {m.context_length // 1000 if m.context_length else '?'}k · {price}" + (" · images" if m.accepts_images else "")
                    + (f" · effort {'/'.join(ef.choices)}" if ef else ""))

        ordered = sorted(ms, key=lambda m: (m.id not in fav, rec.get(m.id, 99), not m.free, m.id))
        items = [(((I.get("star") + " " if m.id in fav else "") + m.id), m.id, det(m)) for m in ordered]

        def toggle_fav(mid):
            if mid in sv.config.favorite_models:
                sv.config.favorite_models.remove(mid)
            else:
                sv.config.favorite_models.append(mid)
            save_config(sv.config)
            self.notify(f"Favoris : {', '.join(sv.config.favorite_models) or 'aucun'}")

        v = await self.app.push_screen_wait(PickerScreen(f"Modèles {sv.mode_label}" + (" gratuits" if free_only else "") + f" ({len(items)}, chat + outils)", items,
                                                         "↑↓ · Entrée choisir · Ctrl+F favori · tapez pour filtrer (ex. gratuit, images) · Échap",
                                                         current=sv.session.model, extra_bindings={"ctrl+f": toggle_fav}))
        if v:
            self._set_model(v)

    async def pick_options(self) -> None:
        sv = self.sv
        params = sv.model_params()
        if not params:
            self.note("Ce modèle n'expose aucun réglage dans le catalogue.", "warn")
            return
        opts = sv.current_options()
        items = []
        for p in params:
            cur = opts.get(p.name)
            val = "défaut" if cur is None else ("on" if cur is True else "off" if cur is False else str(cur))
            d = f"valeur : {val} · défaut du modèle : {p.default}" + (f" · choix : {'/'.join(p.choices)}" if p.choices else "") + (f" — {p.description[:60]}" if p.description else "")
            items.append((p.name, p.name, d))
        name = await self.app.push_screen_wait(PickerScreen(f"Réglages de {sv.model_key}", items))
        if not name:
            return
        p = next(x for x in params if x.name == name)
        if p.kind in ("enum", "boolean"):
            vals = [("défaut du modèle", "__default__", "")] + ([(c, c, "") for c in p.choices] if p.kind == "enum" else [("on", True, ""), ("off", False, "")])
            v = await self.app.push_screen_wait(PickerScreen(name, vals))
            if v is None:
                return
            sv.set_option(name, None if v == "__default__" else v)
        else:
            raw = await self.app.push_screen_wait(TextPromptScreen(f"{name} ({p.kind}) — vide = défaut", str(opts.get(name, ""))))
            if raw is None:
                return
            try:
                sv.set_option(name, variants.coerce(p, raw) if raw.strip() else None)
            except ValueError as ex:
                self.note(f"Valeur invalide : {ex}", "error")
        self.refresh_panels()

    # ------------------------------------------------------------ commandes slash (OpenCode + Eclipse)
    async def run_slash(self, text: str) -> None:
        sv = self.sv
        cmd, _, arg = text[1:].partition(" ")
        arg = arg.strip()
        c = C.resolve(cmd, self.sv.ext.commands())  # liste complète : une commande masquée s'explique au lieu d'être inconnue
        if c is None:
            self.note(f"Commande inconnue : /{cmd}  (voir /help)", "error")
            return
        n = c.name
        if c.kind == "custom":
            return await self._run_custom(c, arg)
        if c.kind == "skill":
            return await self.submit(f"Utilise le skill « {c.name} » (outil skill) pour cette demande : {arg or '(aucun détail)'}", shown=f"/{c.name} {arg}".strip())
        if c.kind == "plugin":
            h = sv.ext.plugins.commands[c.name][2]
            try:
                out = h(arg)
                out = await out if asyncio.iscoroutine(out) else out
                self.note(f"[plugin] {out}", "info")
            except Exception as ex:  # noqa: BLE001
                self.note(f"Erreur du plugin : {ex}", "error")
            return
        h = getattr(self, f"cmd_{n.replace('-', '_')}", None)
        if h is None:
            self.note(f"/{n} n'est pas encore implémentée.", "warn")
            return
        await h(arg)

    async def _run_custom(self, c: C.Command, arg: str) -> None:
        sv = self.sv
        if c.agent and c.agent in sv.ext.modes:
            sv.set_agent(c.agent)
        if c.model:
            mid, _, var = c.model.partition("#")
            mid = mid.split("/")[-1]
            if not sv.is_cli and mid in sv.models:
                self._set_model(mid)
                p = variants.effort_param(sv.models[mid].params)
                if var and p and var in p.choices:
                    sv.set_option(p.name, var)
        await self.submit(C.expand_template(c.template, arg), shown=f"/{c.name} {arg}".strip())

    # --- OpenCode ---
    async def cmd_help(self, arg):
        await self.app.push_screen_wait(InfoScreen("Aide — commandes et raccourcis", Group(help_table(self._commands()), Text(""), keys_table())))

    async def cmd_exit(self, arg):
        await self.app.action_quit()

    async def cmd_new(self, arg):
        await self.app.switch(str(self.sv.ctx.workspace.root), None)

    async def cmd_cg(self, arg):
        if self.busy:
            self.note("Une réponse est en cours.", "warn")
            return
        lead = await self.app.push_screen_wait(PickerScreen("Nouvelle discussion Claude Code et Codex", [
            ("Claude Code pilote", "claude", "Codex participe à l’exécution"),
            ("Codex pilote", "codex", "Claude Code participe à l’exécution"),
            ("Collaboration", "both", "Coordination alternée"),
        ]))
        if lead:
            await self.app.switch(str(self.sv.ctx.workspace.root), None, cg_lead=lead)

    async def cmd_sessions(self, arg):
        ss = list_sessions()
        items = [(f"{s.id}  {datetime.fromtimestamp(s.updated):%d/%m %H:%M}  {Path(s.workspace).name}", s.id, f"{s.title or s.model or s.mode}") for s in ss[:50]]
        v = await self.app.push_screen_wait(PickerScreen("Sessions", items, "Entrée : reprendre · Ctrl+D : supprimer · Échap", current=self.sv.session.id,
                                                         extra_bindings={"ctrl+d": lambda sid: ("__delete__", sid)}))
        to_delete = [v[1]] if isinstance(v, tuple) else []
        if isinstance(v, tuple):
            v = None
        if to_delete and to_delete[0] != self.sv.session.id:
            from ..session import delete_session
            ok = await self.app.push_screen_wait(ConfirmScreen(f"Supprimer la session {to_delete[0]} ?", "", "Son état de travail est supprimé ; les archives de la mémoire du projet sont conservées."))
            if ok and delete_session(to_delete[0]):
                self.toast(f"Session {to_delete[0]} supprimée.")
            return
        elif to_delete:
            self.toast("Impossible de supprimer la session en cours.", "warning")
            return
        if v and v != self.sv.session.id:
            await self.app.switch(None, v)

    async def cmd_models(self, arg):
        await self.pick_model(free_only=arg.strip() in ("free", "gratuit", "gratuits"))

    async def cmd_model(self, arg):
        sv = self.sv
        if not arg:
            return await self.pick_model()
        if not sv.is_cli and sv.models and arg not in sv.models:
            self.note(f"Modèle inconnu du catalogue {sv.mode_label} : {arg}", "error")
            return
        self._set_model(arg)

    async def cmd_themes(self, arg):
        app = self.app
        names = sorted(app.available_themes)
        old = app.theme
        v = await app.push_screen_wait(PickerScreen("Thèmes", [(n, n, "") for n in names], current=old, on_highlight=lambda n: setattr(app, "theme", n)))
        app.theme = v or old
        if v:
            self.sv.config.theme = v
            save_config(self.sv.config)

    async def cmd_thinking(self, arg):
        self.show_thinking = not self.show_thinking
        for b in self.query(ThinkingBlock):
            b.set_class(self.show_thinking, "visible")
        self.note(f"Réflexion du modèle : {'affichée' if self.show_thinking else 'masquée'} (n'active ni ne désactive le raisonnement : voir Ctrl+T)", "ok")

    async def cmd_compact(self, arg):
        sv = self.sv
        sid = compact_segment(sv.memory, sv.session.conversation_id, keep_recent=6, min_messages=2)
        did = synthesize_district(sv.memory, sv.session.district_id)
        for s in [sid, did]:
            if s:
                r = verify_summary(sv.memory, s)
                self.note(f"summary:{s} créé — vérification : {'OK' if r.ok else 'PROBLÈMES : ' + '; '.join(r.problems[:3])}", "ok" if r.ok else "warn")
        if not sid:
            self.note("Rien à compacter pour le segment (trop peu d'échanges anciens). Archives intactes.", "info")

    async def cmd_undo(self, arg):
        if self.busy:
            self.note("Interrompez d'abord l'opération en cours (Échap).", "warn")
            return
        r = self.sv.undo()
        if r is None:
            self.note("Rien à annuler.", "warn")
            return
        files = f" — {len(r['files'])} fichier(s) restauré(s)/supprimé(s)" if r["git"] else " — fichiers NON restaurés (le projet n'est pas un dépôt Git)"
        self.note(f"{I.get('undo')} Message annulé{files}. /redo pour rétablir.", "ok" if r["git"] else "warn")
        inp = self.prompt()
        inp.value = r["text"]
        inp.cursor_position = len(inp.value)
        self.refresh_panels()

    async def cmd_redo(self, arg):
        r = self.sv.redo()
        if r is None:
            self.note("Rien à rétablir (disponible seulement après /undo).", "warn")
            return
        self.note(f"{I.get('redo')} Message rétabli — {len(r['files'])} fichier(s) restauré(s)." if r["git"] else f"{I.get('redo')} Message rétabli (fichiers non gérés hors Git).", "ok")
        self.prompt().value = ""
        self.refresh_panels()

    async def cmd_editor(self, arg):
        editor = os.environ.get("EDITOR") or os.environ.get("VISUAL") or next((e for e in ("nano", "vim", "vi", "notepad") if shutil.which(e)), None)
        if not editor:
            self.note("Aucun éditeur : définissez la variable EDITOR.", "error")
            return
        inp = self.prompt()
        with tempfile.NamedTemporaryFile("w+", suffix=".md", delete=False, encoding="utf-8") as f:
            f.write(inp.value)
            path = f.name
        try:
            with self.app.suspend():
                subprocess.run([*shlex.split(editor), path])
            inp.value = Path(path).read_text(encoding="utf-8").rstrip("\n")
            inp.focus()
        finally:
            Path(path).unlink(missing_ok=True)

    async def cmd_export(self, arg):
        d = data_dir() / "exports"
        d.mkdir(exist_ok=True)
        f = d / f"session-{self.sv.session.id}.md"
        f.write_text(self.sv.export_markdown(), encoding="utf-8")
        self.note(f"Exporté : {f}", "ok")
        editor = os.environ.get("EDITOR") or os.environ.get("VISUAL")
        if editor:
            with self.app.suspend():
                subprocess.run([*shlex.split(editor), str(f)])

    async def cmd_init(self, arg):
        await self.submit(INIT_PROMPT, shown="/init")

    async def cmd_update(self, arg):
        lines = [f"Eclipse {__version__} (installation locale — aucun canal de mise à jour publié : `git pull` + `pip install -e .` si vous suivez le dépôt)"]
        try:
            r = subprocess.run([find_binary("claude", self.sv.config) or self.sv.config.claude_bin, "--version"], capture_output=True, text=True, timeout=10)
            lines.append(f"Claude Code : {r.stdout.strip() or r.stderr.strip()}  (mise à jour : `claude update` dans un terminal)")
        except Exception:  # noqa: BLE001
            lines.append("Claude Code : introuvable")
        await self.app.push_screen_wait(InfoScreen("Versions", Text("\n".join(lines))))

    async def cmd_connect(self, arg):
        """Connexions en 3 blocs : agents installés (détection automatique), fournisseurs par clé d'API, serveurs locaux compatibles."""
        from .. import connections as CX
        sv = self.sv
        refresh = False
        while True:
            if refresh:
                self.toast("Détection des agents…")
            det, locs = await asyncio.gather(asyncio.to_thread(CX.agents, False, refresh, sv.config), CX.local_servers())
            refresh = False
            items: list = [("1 · AGENTS INSTALLÉS SUR CET ORDINATEUR  (détection automatique, rien à saisir)", None, "")]
            for d in det:
                if d["installed"]:
                    items.append((f"{I.get('agent')} {d['label']}", d["id"], f"{I.get('ok')} {d['path']} · trouvé via : {d['source']} · {d['note']}"))
                else:
                    items.append((f"{I.get('circle_open')} {d['label']}  — non installé", "path:" + d["agent"], f"{d['reason']} · Entrée : indiquer son chemin"))
            items.append((f"{I.get('retry')} Détecter à nouveau", "__redetect__", "relit le PATH de votre shell et les dossiers d'installation (/detect)"))
            items.append((f"{I.get('folder')} Indiquer le chemin d'un agent…", "__path__", "exécutable choisi à la main, prioritaire sur la détection"))
            items.append(("2 · FOURNISSEURS PAR CLÉ D'API", None, ""))
            for a in CX.apis():
                st = f"{I.get('ok')} clé : {a['key_source']}" if a["has_key"] else "clé à saisir"
                items.append((f"{I.get('key')} {a['label']}", a["id"], f"{st} · {a['note']}"))
            items.append((f"{I.get('provider')} Autre fournisseur (adresse https + clé)…", "__custom__", "nom + adresse compatible OpenAI + clé"))
            items.append(("3 · SERVEURS LOCAUX COMPATIBLES", None, ""))
            for srv in locs:
                if srv["running"]:
                    st = f"{I.get('ok')} actif · " + (f"{len(srv['models'])} modèle(s) : " + ", ".join(srv["models"][:3]) if srv["models"] else "aucun modèle chargé")
                else:
                    st = srv["error"]
                items.append((f"{I.get('network')} {srv['label']}", srv["id"], f"{srv['url']} · {st}"))
            items.append((f"{I.get('network')} Ajouter un serveur compatible OpenAI (URL)…", "__local__", "ex. http://localhost:8080/v1 · aucune clé pour une adresse locale"))
            v = await self.app.push_screen_wait(PickerScreen("Connexions", items, current=("api:" + sv.mode) if not sv.is_cli else sv.mode,
                                                             hint="Entrée : utiliser · clés stockées dans " + credentials.storage_kind()))
            if not v:
                return
            if v == "__redetect__":
                refresh = True
                continue
            if v == "__path__" or v.startswith("path:"):
                await self._agent_path(v[5:] if v.startswith("path:") else "")
                continue
            if v == "__custom__":
                return await self._connect_custom()
            if v == "__local__":
                return await self._connect_custom(local=True)
            kind, _, ident = v.partition(":")
            if v == "claude" or kind == "cli":
                return await self.cmd_provider(v)
            return await self._connect_api(ident)

    async def _agent_path(self, aid: str) -> None:
        from ..cli_agents import all_adapters
        from .. import connections as CX
        if not aid:
            aid = await self.app.push_screen_wait(PickerScreen("Quel agent ?", [(a.label, a.id, " / ".join(a.binaries)) for a in all_adapters()]))
            if not aid:
                return
        cur = self.sv.config.agent_paths.get(aid, "")
        raw = await self.app.push_screen_wait(TextPromptScreen(f"Chemin de l'exécutable ({aid}) — vide : détection automatique", cur))
        if raw is None:
            return
        ok, msg, _ = await asyncio.to_thread(CX.set_agent_path, aid, raw, self.sv.config)
        self.note(msg, "ok" if ok else "error")

    async def cmd_detect(self, arg):
        """/detect : relance la détection des agents (chemin, version, source)."""
        from .. import connections as CX
        self.toast("Détection des agents…")
        det = await asyncio.to_thread(CX.agents, True, True, self.sv.config)
        lines = []
        for d in det:
            if d["installed"]:
                lines.append(f"{I.get('ok')} {d['label']:20} {d['path']}  {d['version'] or d['version_error']}  (via {d['source']})")
            else:
                lines.append(f"{I.get('circle_open')} {d['label']:20} non installé — {d['reason']}")
        await self.app.push_screen_wait(InfoScreen("Agents détectés", Text("\n".join(lines) + "\n\nChemin manuel : /agent-path ID CHEMIN")))
        self.refresh_panels()

    async def cmd_agent_path(self, arg):
        """/agent-path ID [CHEMIN] : chemin d'un agent indiqué à la main (vide : retour à la détection automatique)."""
        from .. import connections as CX
        aid, _, path = (arg or "").partition(" ")
        if not aid:
            return await self._agent_path("")
        if not path.strip():
            return await self._agent_path(aid)
        ok, msg, _ = await asyncio.to_thread(CX.set_agent_path, aid, path, self.sv.config)
        self.note(msg, "ok" if ok else "error")

    async def _connect_api(self, pid: str, new_key: str | None = None) -> None:
        sv = self.sv
        spec = get_spec(pid)
        if spec is None:
            self.note(f"Fournisseur inconnu : {pid}", "error")
            return
        key = new_key
        if spec.key_required and not has_credentials(spec):
            key = await self.app.push_screen_wait(TextPromptScreen(f"Clé d'API {spec.label} (saisie masquée ; stockée : {credentials.storage_kind()})", password=True))
            if not key:
                return
        self.note(f"Connexion à {spec.label}…", "info")
        ok, msg = await sv.connect_provider(spec.id, key)
        self.note((I.get("ok") + " " if ok else I.get("error") + " ") + msg, "ok" if ok else "error")
        if ok:
            self.refresh_panels()
            if not sv.session.model:
                await self.pick_model()

    async def _connect_custom(self, local: bool = False) -> None:
        from .. import connections as CX
        url = await self.app.push_screen_wait(TextPromptScreen(
            "Adresse du serveur compatible OpenAI" + (" (ex. http://localhost:1234/v1)" if local else " (https://…/v1)"), "http://localhost:" if local else "https://"))
        if not url:
            return
        name = await self.app.push_screen_wait(TextPromptScreen("Nom affiché (ex. monserveur)"))
        if name is None:
            return
        ok, msg, spec = CX.add_server(name, url)
        if not ok:
            self.note(msg, "error")
            return
        self.note(msg, "ok")
        await self._connect_api(spec.id)

    async def cmd_disconnect(self, arg):
        spec = get_spec(arg) if arg else None
        if spec is None:
            self.note("Usage : /disconnect ID  (ex. openrouter). Les clés en variable d'environnement ne sont pas touchées.", "error")
            return
        self.note(f"Clé de {spec.label} oubliée." if credentials.delete_key(spec.id) else f"Aucune clé enregistrée pour {spec.label}.", "ok")
        self.refresh_panels()

    # --- Eclipse ---
    async def cmd_provider(self, arg):
        sv = self.sv
        if not arg:
            return await self.cmd_connect("")
        aid = arg[4:] if arg.startswith("cli:") else arg
        if arg != "claude" and not arg.startswith("cli:") and get_adapter(arg) is not None:
            arg = "cli:" + arg
        try:
            sv.set_mode(arg)
        except KeyError:
            self.note(f"Fournisseur inconnu : {arg} (voir /connect)", "error")
            return
        if arg == "claude":
            self.note("Fournisseur : Claude Code — il agit via les outils d'Eclipse (aperçu + autorisation), consommation mesurée, limite propre (/limit).", "ok")
        elif arg.startswith("cli:"):
            a = get_adapter(aid)
            self.note(f"Agent délégué : {a.label} — il exécute ses PROPRES outils (aperçu des commandes impossible). Tokens mesurés/estimés et limite par Eclipse. {a.verified}", "warn")
        else:
            if not sv.provider.configured():
                self.note(f"{sv.mode_label} sélectionné mais sans clé : /connect pour la saisir.", "warn")
            else:
                await sv.load_models()
                self.note(f"Fournisseur : {sv.mode_label} — {len(sv.models)} modèles.", "ok")
        self.refresh_panels()

    async def cmd_mode(self, arg):
        if arg in ("poe", "claude") or get_spec(arg) or (get_adapter(arg) and arg not in sv_modes(self.sv)):
            return await self.cmd_provider(arg)
        if not arg:
            return await self.cmd_agents("")
        try:
            w = self.sv.set_agent(arg)
        except KeyError:
            self.note(f"Mode inconnu : {arg} (disponibles : {', '.join(self.sv.ext.modes)})", "error")
            return
        self.note(f"Mode → {arg}" + (f" {I.get('warn')} {w}" if w else ""), "ok")
        self.refresh_panels()

    async def cmd_agents(self, arg):
        sv = self.sv
        items = [(n + (" (sous-agent)" if not m.primary else ""), n, f"{m.scope} · {m.description}" + (" · lecture seule" if m.readonly else "")) for n, m in sv.ext.modes.items()]
        v = await self.app.push_screen_wait(PickerScreen("Modes / agents (Tab pour alterner)", items, current=sv.session.agent))
        if v:
            await self.cmd_mode(v)

    async def cmd_effort(self, arg):
        """/effort : rapide / normal / profond (traduits vers les valeurs RÉELLES du modèle actif), ou une valeur exacte du catalogue.
        /effort par-defaut NIVEAU : effort appliqué quand il n'a pas été choisi pour le modèle (même réglage que le desktop)."""
        sv = self.sv
        a = (arg or "").strip()
        if a.split(" ")[0].lower() in ("par-defaut", "par-défaut", "pardefaut", "default-level"):
            lv = a.partition(" ")[2].strip() or "défaut"
            try:
                from ..config import Config
                sv.config.default_effort = Config(default_effort=lv).default_effort
            except Exception:  # noqa: BLE001
                self.note("Niveau par défaut : défaut, rapide, normal ou profond.", "error")
                return
            save_config(sv.config)
            self.toast(f"Effort par défaut → {sv.config.default_effort}")
            self.refresh_panels()
            return
        p = variants.effort_param(sv.model_params())
        if not p:
            self.note(f"{sv.model_key or 'ce modèle'} ne propose pas de réglage d'effort (voir /options pour ses autres réglages).", "warn")
            return
        if not a:
            cur = sv.current_options().get(p.name)
            items = [("défaut du modèle", "__default__", f"défaut : {p.default}" if p.default else "valeur par défaut du fournisseur")]
            items += [(f"{lv}", lv, f"→ {variants.level_value(p, lv)}") for lv in variants.LEVELS]
            items += [(c, c, "valeur exacte du modèle") for c in p.choices]
            v = await self.app.push_screen_wait(PickerScreen(f"Effort — {p.name} ({sv.model_key}) · par défaut : {sv.config.default_effort}", items,
                                                             current=variants.level_of(p, cur) or cur or "__default__"))
            if v is None:
                return
            a = "défaut" if v == "__default__" else v
        try:
            if a.lower() in ("défaut", "default"):
                val = None
            elif a.lower() in variants.LEVEL_ALIASES:
                val = variants.level_value(p, a)
            else:
                val = variants.coerce(p, a)
            sv.set_option(p.name, val)
            lv = variants.level_of(p, val)
            self.toast(f"Effort ({p.name}) → {val if val is not None else 'défaut'}" + (f" ({lv})" if lv and lv != a else ""))
        except ValueError as ex:
            self.note(f"Valeur invalide : {ex} · ou rapide, normal, profond", "error")
        self.refresh_panels()

    async def cmd_permissions(self, arg):
        pm = self.sv.ctx.permissions
        if arg in ("ask", "edits"):
            pm.set_mode(arg)
            self.note({"ask": "Permissions : tout est confirmé.", "edits": "Permissions : modifications de fichiers du projet acceptées d'office (commandes et le reste confirmés)."}[arg], "ok")
            self.refresh_panels()
        elif arg == "bypass":
            await self.cmd_bypass("on")
        else:
            items = [("ask", "ask", "tout confirmer (recommandé)"), ("edits", "edits", "modifications de fichiers du projet acceptées d'office"),
                     ("bypass", "bypass", "aucune confirmation, sauf actions destructrices / hors projet"), ("bypass total", "all", "AUCUNE confirmation, même destructrice ou hors projet")]
            cur = "all" if pm.bypass_all else pm.mode
            v = await self.app.push_screen_wait(PickerScreen("Permissions", items, current=cur))
            if v in ("ask", "edits"):
                await self.cmd_permissions(v)
            elif v == "bypass":
                await self.cmd_bypass("on")
            elif v == "all":
                await self.cmd_bypass("all")

    async def cmd_fusion(self, arg):
        """/fusion : le modèle actif peut consulter d'autres assistants (outil ask_helper)."""
        sv, cfg = self.sv, self.sv.config
        sub, _, rest = arg.partition(" ")
        rest = rest.strip()

        def commit(msg: str, level: str = "ok") -> None:
            save_config(cfg)
            sv.rebuild_tools()
            self.note(msg, level)
            self.refresh_panels()

        if sub in ("on", "off"):
            cfg.fusion_enabled = sub == "on"
            if cfg.fusion_enabled and not cfg.fusion_helpers:
                self.note("Fusion activée mais aucun assistant : /fusion add ID (ex. /fusion add cli:opencode) ou /fusion pour choisir.", "warn")
            return commit("Mode fusion " + ("activé" if cfg.fusion_enabled else "désactivé") + ".")
        if sub == "add" and rest:
            h = F.parse_helper(rest)
            if h is None:
                return self.note("Identifiant invalide. Formes : claude · cli:opencode · api:openrouter/modèle", "error")
            if rest not in cfg.fusion_helpers:
                cfg.fusion_helpers.append(rest)
            ok, why = F.status(h)
            return commit(f"Assistant ajouté : {h.label} ({why})", "ok" if ok else "warn")
        if sub in ("remove", "rm") and rest:
            if rest in cfg.fusion_helpers:
                cfg.fusion_helpers.remove(rest)
            return commit(f"Assistant retiré : {rest}")
        if sub == "max" and rest.isdigit():
            cfg.fusion_max_calls = max(1, int(rest))
            return commit(f"Maximum {cfg.fusion_max_calls} consultation(s) par tour.")
        if sub == "list":
            lines = [f"{I.get('ok') if F.status(h)[0] else I.get('error')} {h.id}  {h.label}  ({F.status(h)[1]})" for h in (F.parse_helper(x) for x in cfg.fusion_helpers) if h]
            self.note(f"Fusion {'ACTIVÉE' if cfg.fusion_enabled else 'désactivée'} · max {cfg.fusion_max_calls}/tour\n" + ("\n".join(lines) or "aucun assistant"))
            return
        # sélecteur interactif
        while True:
            items = [(f"Mode fusion : {'ACTIVÉ' if cfg.fusion_enabled else 'désactivé'}", "__toggle__", "Entrée pour basculer")]
            for hid in cfg.fusion_helpers:
                h = F.parse_helper(hid)
                if h:
                    ok, why = F.status(h)
                    items.append(((I.get("ok") + " " if ok else I.get("error") + " ") + h.label, f"rm:{hid}", f"{hid} · {why} · Entrée : retirer"))
            items += [(I.get("agent") + " Ajouter un agent installé…", "__cli__", ""), (I.get("provider") + " Ajouter un modèle d'une API connectée…", "__api__", "")]
            v = await self.app.push_screen_wait(PickerScreen(f"Fusion — assistants consultables par {sv.mode_label}", items,
                                                             hint=f"max {cfg.fusion_max_calls} consultations/tour · le texte envoyé est montré et confirmé · Échap pour fermer"))
            if v is None:
                return
            if v == "__toggle__":
                cfg.fusion_enabled = not cfg.fusion_enabled
                commit("Mode fusion " + ("activé" if cfg.fusion_enabled else "désactivé") + ".")
            elif v.startswith("rm:"):
                cfg.fusion_helpers.remove(v[3:])
                commit(f"Assistant retiré : {v[3:]}")
            elif v == "__cli__":
                cands = [(d.adapter.label, ("claude" if d.adapter.integrated else f"cli:{d.adapter.id}"),
                          (f"détecté {I.get('ok')}" if d.installed else "non installé") + " · " + d.adapter.verified) for d in detect()]
                pick = await self.app.push_screen_wait(PickerScreen("Ajouter un agent", [c for c in cands if c[1] not in cfg.fusion_helpers]))
                if pick:
                    await self.cmd_fusion(f"add {pick}")
                    cfg.fusion_enabled = True
                    commit("Mode fusion activé.")
            elif v == "__api__":
                specs = [(sp.label, sp.id, f"clé {I.get('ok')}" if has_credentials(sp) else "clé absente") for sp in all_specs() if has_credentials(sp)]
                if not specs:
                    self.note("Aucune API connectée : /connect d'abord.", "warn")
                    continue
                pid = await self.app.push_screen_wait(PickerScreen("API connectée", specs))
                if not pid:
                    continue
                self.note("Chargement du catalogue…", "info")
                from ..providers import build_provider
                prov = build_provider(get_spec(pid))
                try:
                    ms = [m for m in await prov.list_models() if m.chat_text]
                except Exception as ex:  # noqa: BLE001
                    self.note(f"Catalogue indisponible : {ex}", "error")
                    continue
                finally:
                    await prov.aclose()
                mid = await self.app.push_screen_wait(PickerScreen(f"Modèle ({pid})", [(m.id, m.id, f"ctx {m.context_length or '?'}") for m in sorted(ms, key=lambda m: m.id)]))
                if mid:
                    await self.cmd_fusion(f"add api:{pid}/{mid}")
                    cfg.fusion_enabled = True
                    commit("Mode fusion activé.")

    async def cmd_bypass(self, arg):
        """Bypass permissions : plus aucune confirmation. Activation confirmée ; jamais restauré au redémarrage ; sudo toujours refusé."""
        pm = self.sv.ctx.permissions
        if arg in ("off", "ask", "non"):
            pm.set_mode("ask")
            self.note("Bypass désactivé : retour au mode ask (tout est confirmé).", "ok")
            self.refresh_panels()
            return
        total = arg in ("all", "total")
        ok = await self.app.push_screen_wait(ConfirmScreen(
            "Activer le BYPASS TOTAL ?" if total else "Activer le BYPASS des permissions ?",
            "",
            ("Plus AUCUNE confirmation : modifications, commandes, suppressions, accès hors du projet, outils MCP/plugins/skills, consultation d'autres modèles. "
             if total else
             "Plus de confirmation pour les modifications, commandes, outils MCP/plugins/skills et consultations d'autres modèles. Les actions DESTRUCTRICES et hors du projet "
             "redemandent confirmation. ")
            + "Aucune sandbox : tout s'exécute avec vos droits. sudo reste refusé. Le mode n'est pas conservé au redémarrage."))
        if not ok:
            self.note("Bypass non activé.", "info")
            return
        pm.set_mode("bypass", bypass_all=total)
        self.note(I.get("bypass") + " BYPASS " + ("TOTAL " if total else "") + "activé — /bypass off pour revenir.", "warn")
        self.refresh_panels()

    async def cmd_options(self, arg):
        await self.pick_options()

    async def cmd_usage(self, arg):
        """/usage : consommation détaillée (jamais d'addition entre mesuré / estimé / saisi / indisponible)."""
        from ..budget import day_start, month_start, week_start
        sv = self.sv
        now = time.time()
        parts = [render_usage(sv.budget, sv.config, sv.models.get(sv.session.model or ""), sv.session.model, sv.session.id,
                              sv.agent.session_tokens, mode=sv.mode, claude_info=sv.claude.info)]
        for label, since in (("Aujourd'hui", day_start(now)), ("Cette semaine", week_start(now)), ("Ce mois", month_start(now))):
            rows = sv.budget.by_model_detail(since)
            t = Table(title=f"{label} — par modèle / agent", title_justify="left", expand=True, header_style="bold")
            for c in ("Modèle / agent", "Req.", "Tokens ↓ (mesurés | estimés)", "Tokens ↑ (mesurés | estimés)", "USD estimé", "Points (par nature)"):
                t.add_column(Text(c), justify="left" if c.startswith("Mod") else "right", no_wrap=True)
            for d in rows[:12]:
                pts = " + ".join(f"{v:.1f} [{k}]" for k, v in d["points"].items() if v) or "—"
                t.add_row(Text(d["model"]), Text(str(d["requests"])), Text(f"{d['tin']['measured']:,} | {d['tin']['estimated']:,}".replace(",", " ")),
                          Text(f"{d['tout']['measured']:,} | {d['tout']['estimated']:,}".replace(",", " ")), Text(f"${d['usd']:.4f}" if d["usd"] else "—"), Text(pts))
            if not rows:
                t.add_row("(aucune requête)", "", "", "", "", "")
            parts += [Text(""), t]
        parts.append(Text("\nRegistre LOCAL : ce que cette application a enregistré, pas l'historique complet de vos comptes. "
                          "Mesuré = renvoyé par le fournisseur/l'agent · estimé = calculé localement · saisi = entré à la main.", style="dim italic"))
        await self.app.push_screen_wait(InfoScreen("Consommation (/usage)", Group(*parts)))

    async def cmd_status(self, arg):
        sv = self.sv
        t = Table(show_header=False, box=None)
        have = bool(os.environ.get("POE_API_KEY"))
        t.add_row("Fournisseur", f"{sv.mode_label}" + ("" if sv.is_cli else f"  (clé : {'présente' if sv.provider.configured() else 'ABSENTE → /connect'})"))
        t.add_row("Agents détectés", ", ".join(f"{d.adapter.label}{' ' + I.get('ok') if d.installed else ''}" for d in detect() if d.installed) or "aucun")
        t.add_row("Mode / agent", sv.session.agent)
        t.add_row("Modèle", (sv.config.claude_model or "défaut") if sv.mode == "claude" else (sv.config.cli_models.get(sv.mode[4:], "défaut de l'agent") if sv.is_cli else (sv.session.model or "—")))
        t.add_row("Réglages", variants.summary(sv.model_params(), sv.current_options()) or "(défauts du modèle)")
        t.add_row("Projet", str(sv.ctx.workspace.root) + (f"  {I.get('branch')} {self.branch}" if self.branch else ""))
        t.add_row("Annuler Git", "disponible" if sv.snap.available else "indisponible (pas un dépôt Git)")
        t.add_row("MCP", "; ".join(f"{m['name']}: {m['state']} ({m['tools']})" for m in sv.mcp.status()) or "aucun")
        t.add_row("Skills", ", ".join(sv.ext.skills) or "aucun")
        t.add_row("Plugins", ", ".join(f"{p.name}{' ' + I.get('ok') if p.loaded else (' ' + I.get('warn') + ' ' + (p.error or '') if p.trusted else ' (non approuvé)')}" for p in sv.ext.plugins.plugins.values()) or "aucun")
        t.add_row("Modes", ", ".join(sv.ext.modes))
        await self.app.push_screen_wait(InfoScreen("État", Group(t, Text(""), render_usage(sv.budget, sv.config, sv.models.get(sv.session.model or ""), sv.session.model,
                                                                                         sv.session.id, mode=sv.mode, claude_info=sv.claude.info))))

    async def cmd_sidebar(self, arg):
        self.action_toggle_sidebar()

    async def cmd_details(self, arg):
        self.show_details = not self.show_details
        for b in self.query(ToolBlock):
            b.set_details(self.show_details)
        self.note(f"Détails des outils : {'affichés' if self.show_details else 'masqués'}", "ok")

    async def cmd_timeline(self, arg):
        if not self.user_bubbles:
            self.note("Aucun message dans cette session.", "warn")
            return
        items = [(f"{i + 1}. {b.text.splitlines()[0][:70] if b.text else ''}", i, "") for i, b in enumerate(self.user_bubbles)]
        v = await self.app.push_screen_wait(PickerScreen("Chronologie", items))
        if v is not None:
            self.chat().scroll_to_widget(self.user_bubbles[v], animate=False, top=True)

    async def cmd_copy(self, arg):
        answers = list(self.query(AssistantAnswer))
        if not answers:
            self.note("Aucune réponse à copier.", "warn")
            return
        self.app.copy_to_clipboard(answers[-1].buffer)
        self.note("Dernière réponse copiée dans le presse-papiers.", "ok")

    async def cmd_rename(self, arg):
        t = arg or await self.app.push_screen_wait(TextPromptScreen("Titre de la session", self.sv.session.title))
        if t:
            self.sv.session.title = t
            self.sv.session.save()
            self.refresh_panels()

    async def cmd_skills(self, arg):
        sk = self.sv.ext.skills
        if not sk:
            self.note("Aucun skill. Ajoutez .eclipse/skills/NOM/SKILL.md (ou .claude/skills, .opencode/skills, ~/.config/eclipse/skills).", "info")
            return
        items = [(n, n, f"{s.scope} · {s.description}") for n, s in sk.items()]
        v = await self.app.push_screen_wait(PickerScreen("Skills (Entrée : l'utiliser)", items))
        if v:
            await self.submit(f"Utilise le skill « {v} » (outil skill) pour la tâche en cours.", shown=f"/{v}")

    async def cmd_plugins(self, arg):
        sv = self.sv
        sub, _, name = arg.partition(" ")
        name = name.strip()
        if sub in ("trust", "untrust") and name:
            p = sv.ext.plugins.plugins.get(name)
            if not p:
                self.note(f"Plugin inconnu : {name}", "error")
                return
            if sub == "trust":
                ok = await self.app.push_screen_wait(ConfirmScreen(f"Approuver le plugin « {name} » ({p.scope}) ?", p.path.read_text(encoding="utf-8")[:4000],
                                                                   "Ce code s'exécutera avec VOS droits, sans sandbox. Relisez-le. L'approbation est liée à l'empreinte du fichier."))
                if ok:
                    sv.ext.plugins.trust(name)
                    sv.reload_extensions()
                    self.note(f"Plugin « {name} » approuvé et chargé.", "ok")
            else:
                sv.ext.plugins.untrust(name)
                sv.reload_extensions()
                self.note(f"Approbation retirée pour « {name} ».", "ok")
            self.refresh_panels()
            return
        if not sv.ext.plugins.plugins:
            self.note("Aucun plugin. Placez un .py dans .eclipse/plugins/ (API : voir README).", "info")
            return
        for p in sv.ext.plugins.plugins.values():
            st = f"chargé {I.get('ok')}" if p.loaded else (f"erreur : {p.error}" if p.error else ("approuvé" if p.trusted else "NON approuvé → /plugins trust " + p.name))
            self.note(f"{p.name} ({p.scope}) — {st}" + (f" — outils : {', '.join(p.tools)}" if p.tools else ""), "info" if p.trusted else "warn")

    async def cmd_reload(self, arg):
        self.sv.reload_extensions()
        self._files_cache = None
        self.note(f"Rechargé : {len(self.sv.ext.skills)} skills, {len(self.sv.ext.modes)} modes, {len(self.sv.ext.custom)} commandes, "
                  f"{len(self.sv.ext.plugins.plugins)} plugins.", "ok")
        self.refresh_panels()

    async def cmd_mcp(self, arg):
        st = self.sv.mcp.status()
        self.note("\n".join(f"{s['name']}: {s['state']} ({s['tools']} outils){' — ' + s['error'] if s['error'] else ''}" for s in st) or
                  "Aucun serveur MCP configuré (voir README : mcp.json).")

    async def cmd_memory(self, arg):
        sv = self.sv
        hits = sv.memory.search(arg, district_id=sv.session.district_id, limit=8) if arg else []
        self.note("\n".join(f"{h.ref} ({h.layer}) {h.text[:200]}" for h in hits) or "aucun résultat")

    async def cmd_verify(self, arg):
        if arg.isdigit():
            r = verify_summary(self.sv.memory, int(arg))
            self.note(f"summary:{arg} : {'OK' if r.ok else 'PROBLÈMES : ' + '; '.join(r.problems)} ({r.checked_archives} archives contrôlées)", "ok" if r.ok else "warn")
        else:
            self.note("Usage : /verify ID_RESUME", "error")

    async def cmd_todo(self, arg):
        sub, _, rest = arg.partition(" ")
        t = self.sv.ctx.todos
        if sub == "add" and rest:
            t.add(rest)
        elif sub in ("doing", "done") and rest.isdigit():
            t.set_status(int(rest), "in_progress" if sub == "doing" else "done")
        elif sub == "clear":
            t.clear()
        else:
            self.note("Usage : /todo add TEXTE | doing N | done N | clear", "error")

    def _subscription_guard(self) -> bool:
        if not self.sv.is_cli:
            return False
        self.note(f"{I.get('subscription')} La consommation est gérée par l'abonnement {self.sv.mode_label} : les budgets en points ne s'appliquent pas. "
                  "Pour une limite de tokens propre à Eclipse : /limit N [période].", "info")
        return True

    async def cmd_define_token(self, arg):
        if self._subscription_guard():
            return
        sv = self.sv
        res = await self.app.push_screen_wait(DefineTokenScreen(sv.budget))
        if res is None:
            return
        if res.get("clear"):
            sv.budget.clear_envelope("temporary")
            self.note("Budget temporaire supprimé.")
        else:
            cur = sv.model_key or "*"

            sv.budget.set_envelope(kind="temporary", name="temporaire", amount_points=res["amount_points"], token_limit=res["token_limit"],
                                   period_s=res["period_s"], scope=["*"] if res["scope"] == "all" else [cur], on_exhaust=res["on_exhaust"],
                                   carry_over=res["carry_over"])
            self.note("Budget local défini (le renouvellement ne recrée aucun point chez le fournisseur).", "ok")
            if not sv.config.points_per_usd:
                self.note("Sans taux points/USD (/rate N), les dépenses en points restent indisponibles : le plafond en points ne pourra pas être appliqué.", "warn")
        self.refresh_panels()

    async def cmd_claude_limit(self, arg):
        sv = self.sv
        parts = arg.split()
        try:
            if parts and parts[0] in ("off", "aucune"):
                sv.budget.clear_envelope("claude")
                self.note("Limite supprimée.")
            else:
                n = int(parts[0].replace("_", ""))
                period = parse_duration(parts[1]) if len(parts) > 1 else 0
                scope = sv.model_key if sv.is_cli else "claude-code"
                sv.budget.set_envelope(kind="claude", name=scope, amount_points=None, token_limit=n, period_s=period, scope=[scope],
                                       on_exhaust="pause", carry_over=False)
                self.note(f"Limite {sv.mode_label if sv.is_cli else 'Claude'} : {n:,} tokens (entrée neuve + sortie, hors cache relu)".replace(",", " ") + (f", renouvelée toutes les {parts[1]}" if period else "") + " — pause à épuisement.", "ok")
        except (ValueError, IndexError):
            self.note("Usage : /claude-limit 200000 [5h] | /claude-limit off", "error")
        self.refresh_panels()

    async def cmd_rate(self, arg):
        if self._subscription_guard():
            return
        try:
            self.sv.config.points_per_usd = float(arg.replace(",", "."))
            save_config(self.sv.config)
            self.toast(f"Taux saisi : {self.sv.config.points_per_usd:g} points/USD")
        except ValueError:
            self.note("Usage : /rate 30000", "error")
        self.refresh_panels()

    async def cmd_spent(self, arg):
        if self._subscription_guard():
            return
        try:
            self.sv.budget.add_manual(self.sv.session.id, float(arg.replace(",", ".")))
            self.note("Dépense saisie à la main enregistrée [saisi].", "ok")
        except ValueError:
            self.note("Usage : /spent 12.5", "error")
        self.refresh_panels()


# ======================================================================= palette de commandes (Ctrl+P)
    # ================================================================ 0.2.0
    async def cmd_free(self, arg):
        """Modèles gratuits : sources réelles, état, mise en place guidée (rien n'est contourné)."""
        from .. import free as FR
        self.toast("Recherche des sources gratuites…")
        srcs = await FR.sources()
        items = [((I.get("ok") + " " if s.ready else I.get("circle_open") + " ") + s.label, s.id, f"{s.status} — {s.tradeoff}") for s in srcs]
        v = await self.app.push_screen_wait(PickerScreen("Modèles gratuits", items, hint="Entrée : mettre en place · détails dans /help et le README"))
        if not v:
            return
        sv = self.sv
        if v == "opencode":
            models = await FR.opencode_free_models()
            if not models:
                self.note("OpenCode n'est pas installé ou ne liste pas de modèle gratuit (https://opencode.ai).", "warn")
                return
            m = await self.app.push_screen_wait(PickerScreen("Modèles gratuits d'OpenCode (sans compte)", [(x, x, "gratuit") for x in models]))
            if m:
                sv.config.cli_models["opencode"] = m
                save_config(sv.config)
                await self.cmd_provider("opencode")
                self.toast(f"OpenCode · {m}")
        elif v == "openrouter":
            spec = get_spec("openrouter")
            if not has_credentials(spec):
                self.note("OpenRouter : créez un compte gratuit sur https://openrouter.ai puis une clé (Keys). Saisissez-la ci-dessous.", "info")
                await self._connect_api("openrouter")
            else:
                await sv.connect_provider("openrouter")
            if sv.mode == "openrouter":
                await self.pick_model(free_only=True)
        elif v == "ollama":
            await self._setup_ollama()
        else:
            await self._connect_api(v)

    async def _setup_ollama(self) -> None:
        from .. import free as FR
        if not shutil.which("ollama"):
            self.note("Ollama n'est pas installé : https://ollama.com (puis /free).", "warn")
            return
        up, models = await FR.ollama_status()
        if not up:
            ok = await self.app.push_screen_wait(ConfirmScreen("Démarrer le serveur Ollama (ollama serve) ?", "", "Il tournera en arrière-plan tant qu'Eclipse est ouvert."))
            if not ok:
                return
            self._ollama_proc = subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **PC.group_kwargs())
            for _ in range(30):
                await asyncio.sleep(0.5)
                up, models = await FR.ollama_status()
                if up:
                    break
            if not up:
                self.note("Le serveur Ollama n'a pas démarré.", "error")
                return
        if not models:
            pick = await self.app.push_screen_wait(PickerScreen("Télécharger un modèle local (une fois)", [(n, n, d) for n, d in FR.OLLAMA_SUGGESTED]))
            if not pick:
                return
            ok = await self.app.push_screen_wait(ConfirmScreen(f"Télécharger {pick} ?", "", "Téléchargement de plusieurs Go ; sans carte graphique, les réponses seront lentes."))
            if not ok:
                return
            b = ToolBlock("run_command", f"ollama pull {pick}")
            self.add(b)
            proc = await asyncio.create_subprocess_exec("ollama", "pull", pick, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await proc.communicate()
            b.finish(proc.returncode == 0, out.decode(errors="replace")[-600:])
            if proc.returncode != 0:
                return
        await self.cmd_provider("ollama")
        await self.pick_model()

    async def cmd_retry(self, arg):
        if self.busy:
            self.toast("Interrompez d'abord (Échap).", "warning")
            return
        r = self.sv.undo()
        if r is None:
            self.toast("Rien à relancer.", "warning")
            return
        self.note(I.get("retry") + " Relance du dernier message" + ("" if r["git"] else " (fichiers non restaurés : pas de dépôt Git)"), "info")
        await self.submit(r["text"])

    async def cmd_edit(self, arg):
        await self.cmd_undo(arg)

    async def cmd_fork(self, arg):
        s = self.sv.fork_session()
        self.toast(f"Session dupliquée : {s.id}")
        await self.app.switch(None, s.id)

    async def cmd_add_dir(self, arg):
        if not arg:
            self.note("Usage : /add-dir CHEMIN — autorise lecture/écriture dans ce dossier (confirmations habituelles).", "info")
            return
        try:
            d = self.sv.add_dir(arg)
        except NotADirectoryError as ex:
            self.note(f"Dossier introuvable : {ex}", "error")
            return
        self._files_cache = None
        self.note(f"Dossier autorisé en plus du projet : {d}", "ok")
        self.refresh_panels()

    async def cmd_system(self, arg):
        g = data_dir() / "instructions.md"
        pj = self.sv.ctx.workspace.root / ".eclipse" / "instructions.md"
        sub, _, rest = arg.partition(" ")
        if sub == "set" and rest:
            g.write_text(rest.strip() + "\n", encoding="utf-8")
            self.toast("Consignes globales enregistrées.")
        elif sub == "project" and rest:
            pj.parent.mkdir(exist_ok=True)
            pj.write_text(rest.strip() + "\n", encoding="utf-8")
            self.toast("Consignes du projet enregistrées (.eclipse/instructions.md).")
        elif sub == "clear":
            f = pj if rest.strip() == "project" else g
            f.unlink(missing_ok=True)
            self.toast("Consignes effacées.")
        else:
            cur = Text()
            for label, f in (("Globales", g), ("Projet", pj)):
                cur.append(f"{label} ({f}) :\n", style="bold")
                cur.append((f.read_text(encoding="utf-8").strip() if f.is_file() else "(aucune)") + "\n\n")
            cur.append("/system set TEXTE · /system project TEXTE · /system clear [project] · /editor pour un texte long", style="dim")
            await self.app.push_screen_wait(InfoScreen("Consignes personnelles", cur))

    async def cmd_config(self, arg):
        from ..config import Config
        sv = self.sv
        while True:
            data = sv.config.model_dump()
            skip = {"recent_models", "favorite_models", "cli_models", "fusion_helpers", "last_alert_level", "agent_paths"}
            items = [(f"{k} = {json_short(v)}", k, (Config.model_fields[k].description or "")) for k, v in data.items() if k not in skip]
            key = await self.app.push_screen_wait(PickerScreen("Réglages (Entrée : modifier)", items))
            if not key:
                return
            cur = data[key]
            if isinstance(cur, bool):
                data[key] = not cur
            else:
                raw = await self.app.push_screen_wait(TextPromptScreen(f"{key} (vide = aucune valeur)", "" if cur is None else str(cur)))
                if raw is None:
                    continue
                data[key] = None if raw.strip() == "" and cur is None else raw.strip()
            try:
                new = Config.model_validate(data)
            except Exception as ex:  # noqa: BLE001
                self.note(f"Valeur refusée pour {key} : {str(ex).splitlines()[-1] if str(ex) else ex}", "error")
                continue
            for k in data:
                setattr(sv.config, k, getattr(new, k))
            save_config(sv.config)
            self.toast(f"{key} = {getattr(sv.config, key)}")
            self.refresh_panels()

    async def cmd_doctor(self, arg):
        from ..diagnostics import doctor
        self.toast("Diagnostic en cours…")
        checks = await doctor(self.sv)
        t = Table(show_header=False, box=None, padding=(0, 1), expand=True)
        icon = {"ok": (I.get("ok"), "green"), "warn": (I.get("warn"), "yellow"), "fail": (I.get("error"), "red"), "info": (I.get("info"), "cyan")}
        for c in checks:
            i, col = icon[c.status]
            t.add_row(Text(i, style=f"bold {col}"), Text(c.name, style="bold"), Text(c.detail))
        await self.app.push_screen_wait(InfoScreen("Diagnostic (/doctor)", t))

    async def cmd_context(self, arg):
        from ..diagnostics import context_breakdown
        d = context_breakdown(self.sv)
        t = Table(show_header=True, header_style="bold", box=None, expand=True)
        t.add_column("Élément")
        t.add_column("≈ tokens", justify="right")
        t.add_column("part", justify="right")
        for name, n in d["parts"]:
            t.add_row(name, f"{n:,}".replace(",", " "), f"{n / d['total'] * 100:.0f} %" if d["total"] else "")
        t.add_row(Text("Total estimé", style="bold"), Text(f"{d['total']:,}".replace(",", " "), style="bold"), "")
        info = Text()
        if d["window"]:
            info.append("\nFenêtre du modèle : ")
            info.append_text(bar(d["total"] / d["window"], 24))
            info.append(f"  {d['total']:,} / {d['window']:,} tokens".replace(",", " "))
            info.append(f"\nRéservé aux réponses et résultats d'outils : {d['reserve_ratio'] * 100:.0f} % · utilisable ≈ {d['usable']:,}".replace(",", " "), style="dim")
        info.append("\nEstimation ≈ 4 caractères/token. /compact pour résumer l'ancien historique (archives conservées).", style="dim")
        await self.app.push_screen_wait(InfoScreen("Contexte (/context)", Group(t, info)))

    async def cmd_diff(self, arg):
        from rich.syntax import Syntax
        root = self.sv.ctx.workspace.root
        try:
            st = subprocess.run(["git", "-C", str(root), "status", "--short"], capture_output=True, text=True, timeout=10)
            df = subprocess.run(["git", "-C", str(root), "diff", "HEAD", "--", *([arg] if arg else [])], capture_output=True, text=True, timeout=20)
        except Exception as ex:  # noqa: BLE001
            self.note(f"git indisponible : {ex}", "error")
            return
        if st.returncode != 0:
            self.note("Ce projet n'est pas un dépôt Git.", "warn")
            return
        body = df.stdout[:60_000] or "(aucune différence avec HEAD)"
        await self.app.push_screen_wait(InfoScreen("Modifications (git diff HEAD)", Group(Text(st.stdout or "(arbre propre)", style="bold"), Syntax(body, "diff", word_wrap=True, background_color="default"))))

    async def cmd_login(self, arg):
        if arg:
            await self._connect_api(arg)
        else:
            await self.cmd_connect("")

    async def cmd_logout(self, arg):
        await self.cmd_disconnect(arg)

    async def cmd_attach(self, arg):
        if not arg:
            if self.pending_attachments:
                self.pending_attachments.clear()
                self.toast("Pièces jointes retirées.")
            else:
                self.note("Usage : /attach CHEMIN (image png/jpg/webp/gif ; un fichier texte se joint avec @chemin).", "info")
            self.refresh_panels()
            return
        p = Path(arg).expanduser()
        if not p.is_absolute():
            p = self.sv.ctx.workspace.root / p
        from ..extensions.refs import IMAGE_EXT, MAX_IMAGE
        if not p.is_file():
            self.note(f"Fichier introuvable : {p}", "error")
            return
        if p.suffix.lower() in IMAGE_EXT:
            if p.stat().st_size > MAX_IMAGE:
                self.note("Image trop lourde (> 5 Mo).", "error")
                return
            self.pending_attachments.append(p.resolve())
            self.toast(f"{I.get('attach')} {p.name} sera joint au prochain message")
        else:
            pr = self.prompt()
            pr.value = (pr.text + " " if pr.text else "") + f"@{p}"
            self.toast("Fichier texte ajouté au message (@chemin).")
        self.refresh_panels()


def json_short(v) -> str:
    import json as _j
    t = _j.dumps(v, ensure_ascii=False)
    return t if len(t) <= 40 else t[:39] + "…"


def sv_modes(sv) -> list[str]:
    return list(sv.ext.modes)


class EclipseCommands(Provider):
    async def search(self, query: str) -> Hits:
        scr = self.app.screen
        if not isinstance(scr, WorkScreen):
            return
        m = self.matcher(query)
        for c in scr._commands():
            label = f"/{c.name}"
            score = m.match(label + " " + c.description)
            if score > 0:
                yield Hit(score, m.highlight(label), (lambda n=c.name: scr.run_worker(scr.run_slash("/" + n), exclusive=False)),
                          help=c.description + (f"  [{c.keybind}]" if c.keybind else ""))


class EclipseApp(App):
    TITLE = f"Eclipse (POE · Neural Code) {__version__}"
    COMMANDS = App.COMMANDS | {EclipseCommands}
    BINDINGS = [Binding("ctrl+q", "quit", "Quitter")]
    CSS = "Screen { background: $background; } Markdown { background: transparent; }"

    def __init__(self, path: str | None = None, resume: str | None = None, provider=None):
        super().__init__()
        self._path, self._resume, self._provider = path, resume, provider
        self.sv: Services | None = None
        for t in CUSTOM:
            self.register_theme(t)

    def on_mount(self) -> None:
        cfg = load_config()
        I.configure(cfg.icons)
        self.theme = cfg.theme if cfg.theme in self.available_themes else "eclipse"
        if self._path or self._resume:
            self.open_project(self._path, self._resume)
        else:
            self.push_screen(HomeScreen())

    def open_project(self, path: str | None, resume: str | None, *, cg_lead: str | None = None) -> None:
        cfg = load_config()
        try:
            self.sv = create_services(path or ".", resume=resume, config=cfg, provider=self._provider, cg=cg_lead is not None)
            if cg_lead:
                self.sv.session.cg_lead = cg_lead
                self.sv.session.save()
        except Exception as e:  # noqa: BLE001
            self.notify(f"Ouverture impossible : {e}", severity="error")
            return
        while len(self.screen_stack) > 1:
            self.pop_screen()
        self.push_screen(WorkScreen(self.sv))

    async def switch(self, path: str | None, resume: str | None, *, cg_lead: str | None = None) -> None:
        old = self.sv
        if old:
            await old.close()
        self.open_project(path, resume, cg_lead=cg_lead)

    async def action_quit(self) -> None:
        if self.sv:
            await self.sv.close()
        self.exit()
