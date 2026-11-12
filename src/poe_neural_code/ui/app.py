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
from textual.widgets import Input, Label, OptionList, Static
from textual.widgets.option_list import Option

from .. import __version__, credentials, variants
from ..cli_agents import detect, get_adapter
from .. import fusion as F
from ..providers import ProviderSpec, all_specs, get_spec, has_credentials, save_custom
from ..agent import (AssistantDelta, AssistantMessage, Paused, StatusEvent, ThinkingEvent, ToolFinished, ToolRequested, TurnDone, UsageEvent)
from ..config import load_config, save_config
from ..extensions import commands as C
from ..extensions.refs import fuzzy, list_files
from ..memory.compaction import compact_segment, synthesize_district, verify_summary
from ..paths import data_dir
from ..services import Services, create_services
from ..session import list_sessions
from ..tools.permissions import PermissionRequest
from .modals import (ConfirmScreen, DefineTokenScreen, InfoScreen, PermissionScreen, PickerScreen, TextPromptScreen, help_table, keys_table)
from .panels import render_claude, render_context, render_ext, render_files, render_header, render_todo, render_usage
from .theme import CUSTOM
from .util import parse_duration
from .widgets import AssistantAnswer, DiffBlock, NoticeLine, PromptInput, ThinkingBlock, ToolBlock, UserBubble

LOGO = r"""
 ███████╗ ██████╗██╗     ██╗██████╗ ███████╗███████╗
 ██╔════╝██╔════╝██║     ██║██╔══██╗██╔════╝██╔════╝
 █████╗  ██║     ██║     ██║██████╔╝███████╗█████╗
 ██╔══╝  ██║     ██║     ██║██╔═══╝ ╚════██║██╔══╝
 ███████╗╚██████╗███████╗██║██║     ███████║███████╗
 ╚══════╝ ╚═════╝╚══════╝╚═╝╚═╝     ╚══════╝╚══════╝"""
INIT_PROMPT = ("Analyse ce projet (structure, langages, commandes de build/test, conventions) puis crée ou mets à jour le fichier AGENTS.md à la racine "
               "avec des consignes concises et utiles pour un agent de programmation. S'il existe déjà, améliore-le sans perdre son contenu utile.")
CLAUDE_ALIASES = ["haiku", "sonnet", "opus"]
LEADER_KEYS = {"p": "permissions", "i": "usage", "n": "new", "l": "sessions", "m": "models", "t": "themes", "b": "sidebar", "e": "editor", "x": "export", "c": "compact", "u": "undo",
               "r": "redo", "a": "agents", "g": "timeline", "h": "details", "y": "copy", "q": "exit", "s": "status"}
MODE_COLORS = {"build": "#a78bfa", "plan": "#fbbf24"}


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
    #body { height: 1fr; }
    #main { width: 1fr; }
    #chat { height: 1fr; padding: 0 1; scrollbar-size-vertical: 1; }
    #composer { height: auto; margin: 1 1 0 1; }
    #preview { height: auto; max-height: 12; display: none; background: $panel; border: round $primary 50%; margin-bottom: 0; }
    #preview.show { display: block; }
    #prompt { border: round $primary 60%; background: $surface; }
    #prompt:focus { border: round $primary; }
    #modeline { padding: 0 1; height: 1; color: $text-muted; }
    #hints { padding: 0 2; height: 1; color: $text-muted; }
    #sidebar { width: 40; background: $surface; border-left: tall $primary 30%; padding: 0 1; }
    #sidebar.hidden { display: none; }
    #sb-head { height: auto; margin-bottom: 1; }
    #context, #todo, #files, #ext { height: auto; margin-bottom: 1; }
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
        self.branch = git_branch(sv.ctx.workspace.root)

    # ------------------------------------------------------------ mise en page
    def compose(self) -> ComposeResult:
        with Horizontal(id="body"):
            with Vertical(id="main"):
                yield VerticalScroll(id="chat")
                with Vertical(id="composer"):
                    yield OptionList(id="preview")
                    yield PromptInput(placeholder="Votre instruction…   /commandes   @fichier   !shell", id="prompt")
                    yield Static("", id="modeline")
                yield Static("", id="hints")
            with VerticalScroll(id="sidebar"):
                yield Static("", id="sb-head")
                yield Static("", id="context")
                yield Static("", id="todo")
                yield Static("", id="files")
                yield Static("", id="ext")
                yield Static("", id="usage")

    async def on_mount(self) -> None:
        sv = self.sv
        sv.set_emit(self.handle_agent_event)
        sv.ctx.permissions.asker = self.ask_permission
        sv.ctx.todos.on_change = self.refresh_panels
        self.query_one("#sidebar").set_class(not self.show_sidebar, "hidden")
        chat = self.query_one("#chat", VerticalScroll)
        chat.can_focus = False
        await chat.mount(NoticeLine(f"◆ ECLIPSE  ·  Projet : {sv.ctx.workspace.root}  ·  mode {sv.mode}  ·  /help pour les commandes", "info"))
        if not sv.is_cli and not sv.provider.configured():
            await chat.mount(NoticeLine(f"⚠ {sv.mode_label} : connexion non configurée — tapez /connect pour saisir une clé d'API ou choisir un agent installé. "
                                        "Aucune réponse n'est simulée.", "warn"))
        for r in sv.memory.q("SELECT role, content FROM archive WHERE conversation_id=? ORDER BY id DESC LIMIT 10", (sv.session.conversation_id,))[::-1]:
            if r["role"] in ("user", "assistant"):
                await chat.mount(NoticeLine(f"[reprise] {r['role']}: {' '.join(r['content'].split())[:160]}", "info"))
        self.refresh_panels()
        self.set_interval(1.0, self.refresh_panels)
        self.run_worker(self._startup(), exclusive=False)
        self.query_one("#prompt", Input).focus()

    async def _startup(self) -> None:
        await self.sv.load_models()
        if not self.sv.session.model and not self.sv.is_cli:
            self.note("Aucun modèle choisi. /models pour le sélecteur.", "warn")
        await self.sv.start_mcp()
        self.refresh_panels()

    # ------------------------------------------------------------ rendu
    def chat(self) -> VerticalScroll:
        return self.query_one("#chat", VerticalScroll)

    def add(self, widget) -> None:
        chat = self.chat()
        chat.mount(widget)
        chat.scroll_end(animate=False)

    def note(self, text: str, level: str = "info") -> None:
        self.add(NoticeLine(text, level))

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
        s = variants.summary(sv.model_params(), sv.current_options())
        if s:
            t.append(f"  ·  {s}", style="#f0abfc")
        pm = sv.ctx.permissions
        if pm.mode == "bypass":
            t.append("  ·  ⚠ BYPASS" + (" TOTAL" if pm.bypass_all else ""), style="bold #f87171")
        elif pm.mode == "edits":
            t.append("  ·  ✎ modifications auto", style="#fbbf24")
        if sv.session.undo_stack:
            t.append(f"  ·  ↶{len(sv.session.undo_stack)}", style="dim")
        return t

    def refresh_panels(self) -> None:
        sv = self.sv
        try:
            self.query_one("#sb-head", Static).update(render_header(sv, self.branch))
            self.query_one("#context", Static).update(render_context(sv))
            self.query_one("#todo", Static).update(render_todo(sv.ctx.todos))
            self.query_one("#files", Static).update(render_files(self.modified))
            self.query_one("#ext", Static).update(render_ext(sv))
            self.query_one("#usage", Static).update(render_usage(sv.budget, sv.config, sv.models.get(sv.session.model or ""), sv.session.model,
                                                                 sv.session.id, sv.agent.session_tokens, mode=sv.mode, claude_info=sv.claude.info, compact=True))
            self.query_one("#modeline", Static).update(self.modeline())
            hint = ("⏹ Échap interrompre" if self.busy else "Tab mode") + "  ·  Ctrl+T effort  ·  Ctrl+P commandes  ·  Ctrl+X leader  ·  /help"
            if self.leader_active:
                hint = "LEADER : n nouvelle · l sessions · m modèles · t thèmes · b barre · e éditeur · x export · c compacter · u undo · r redo · a modes · s état"
            self.query_one("#hints", Static).update(Text(hint, style="bold #fbbf24" if self.leader_active else ""))
        except Exception:  # noqa: BLE001 — écran en cours de fermeture
            pass

    def on_resize(self, event) -> None:
        self.query_one("#sidebar").set_class(not self.show_sidebar or event.size.width < 90, "hidden")

    def action_toggle_sidebar(self) -> None:
        self.show_sidebar = not self.show_sidebar
        self.query_one("#sidebar").set_class(not self.show_sidebar, "hidden")
        self.sv.config.sidebar_visible = self.show_sidebar
        save_config(self.sv.config)

    def action_interrupt(self) -> None:
        if self.busy:
            self.sv.agent.interrupt()
            self.sv.claude.interrupt()
            self.note("⏹ interruption demandée…", "warn")

    # ------------------------------------------------------------ événements de l'agent
    def handle_agent_event(self, e) -> None:
        if isinstance(e, AssistantDelta):
            if self.live_answer is None:
                self.live_answer = AssistantAnswer("")
                self.add(self.live_answer)
            self.live_answer.append(e.text)
            self.chat().scroll_end(animate=False)
        elif isinstance(e, AssistantMessage):
            if self.live_answer is not None:
                self.live_answer.finish(e.text)
            else:
                self.add(AssistantAnswer(e.text))
            self.live_answer = None
            self.live_think = None
        elif isinstance(e, ThinkingEvent):
            if self.live_think is None:
                self.live_think = ThinkingBlock()
                self.live_think.set_class(self.show_thinking, "visible")
                self.add(self.live_think)
            self.live_think.append(e.text)
        elif isinstance(e, ToolRequested):
            self.live_answer = None
            summ = e.args.get("command") or e.args.get("path") or e.args.get("name") or ", ".join(f"{k}={str(v)[:30]}" for k, v in e.args.items())
            b = ToolBlock(e.name, str(summ))
            b.set_details(self.show_details)
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
            self.chat().scroll_end(animate=False)
        elif isinstance(e, StatusEvent):
            self.note(("⚠ " if e.level != "info" else "ℹ ") + e.text, {"info": "info", "warn": "warn", "error": "error"}[e.level])
        elif isinstance(e, Paused):
            self.live_answer = None
            self.note("⏸ " + e.reason, "error")
        elif isinstance(e, TurnDone):
            self.busy = False
            self.live_answer = self.live_think = None
        if isinstance(e, (UsageEvent, TurnDone, Paused, ToolFinished)):
            self.refresh_panels()

    async def ask_permission(self, req: PermissionRequest) -> str:
        d = await self.app.push_screen_wait(PermissionScreen(req))
        if req.kind == "write" and req.detail and d != "deny":
            self.add(DiffBlock(req.detail))
        self.note({"once": "→ autorisé (une fois)", "session": "→ autorisé (session)", "deny": "→ refusé"}[d], "ok" if d != "deny" else "warn")
        return d

    # ------------------------------------------------------------ aperçu des commandes / fichiers pendant la frappe
    def _commands(self) -> list[C.Command]:
        return self.sv.ext.commands()

    def on_input_changed(self, e: Input.Changed) -> None:
        if e.input.id != "prompt":
            return
        v = e.value
        prev = self.query_one("#preview", OptionList)
        items: list[tuple[str, str]] = []
        mode = ""
        if v.startswith("/") and " " not in v:
            mode = "cmd"
            for c in C.preview(v, self._commands()):
                t = Text.assemble((f"/{c.name}", "bold #a78bfa"), (f"  {c.description[:70]}", "dim"), (f"   {c.keybind}" if c.keybind else "", "#f0abfc"))
                items.append((f"/{c.name} ", t))
        elif v.startswith("!"):
            mode = "shell"
            cmd = v[1:].strip()
            if cmd:
                items.append(("", Text.assemble(("▶ commande shell : ", "bold #fbbf24"), (cmd, "bold"), ("   (aperçu + confirmation avant exécution)", "dim"))))
        else:
            tok = v.rsplit(" ", 1)[-1]
            if tok.startswith("@") and len(tok) >= 1:
                mode = "file"
                if self._files_cache is None:
                    self._files_cache = list_files(self.sv.ctx.workspace.root)
                for f in fuzzy(self._files_cache, tok[1:], 8):
                    items.append((v[: len(v) - len(tok)] + f"@{f} ", Text.assemble(("@" + f, "bold #22d3ee"))))
        self._preview_items, self._preview_mode = [(a, b) for a, b in items], mode
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
        inp = self.query_one("#prompt", Input)
        inp.value = self._preview_items[i][0]
        inp.cursor_position = len(inp.value)
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
        inp = self.query_one("#prompt", Input)
        if inp.value:
            inp.value = ""
        elif time.time() - self._exit_armed < 2:
            self.app.exit()
        else:
            self._exit_armed = time.time()
            self.note("Ctrl+C encore une fois pour quitter.", "warn")

    def action_scroll_chat(self, d: int) -> None:
        self.chat().scroll_page_down(animate=False) if d > 0 else self.chat().scroll_page_up(animate=False)

    def action_cycle_agent(self, step: int) -> None:
        n = self.sv.next_agent(step)
        self.note(f"Mode → {n}" + (f" — {self.sv.ext.modes[n].description}" if self.sv.ext.modes[n].description else ""), "ok")
        self.refresh_panels()

    def action_cycle_variant(self) -> None:
        r = self.sv.cycle_variant()
        if r is None:
            self.note("Ce modèle ne propose pas de réglage d'effort (voir /options).", "warn")
        else:
            self.note(f"{r[0]} → {r[1] if r[1] is not None else 'défaut du modèle'}", "ok")
        self.refresh_panels()

    def action_cycle_model(self) -> None:
        sv = self.sv
        if sv.is_cli and sv.mode != "claude":
            self.note("Le modèle d'un agent délégué se règle avec /model NOM (option de l'agent).", "warn")
            return
        pool = CLAUDE_ALIASES if sv.mode == "claude" else [m for m in sv.config.recent_models if m in sv.models]
        if not pool:
            self.note("Aucun modèle récent : choisissez-en un avec /models.", "warn")
            return
        cur = sv.config.claude_model if sv.mode == "claude" else sv.session.model
        nxt = pool[(pool.index(cur) + 1) % len(pool)] if cur in pool else pool[0]
        self._set_model(nxt)

    def action_rename(self) -> None:
        self.run_worker(self.run_slash("/rename"), exclusive=False)

    # ------------------------------------------------------------ saisie
    async def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id != "prompt":
            return
        text = e.value.strip()
        v = e.value
        if self._preview_mode in ("cmd", "file") and self.preview_visible():
            i = self.query_one("#preview", OptionList).highlighted or 0
            target = self._preview_items[i][0].strip()
            if self._preview_mode == "file":
                if not v.rstrip().endswith(target.rsplit(" ", 1)[-1]):  # le jeton @… n'est pas encore complet : on complète d'abord
                    self._accept_preview()
                    return
            elif v.startswith("/") and " " not in v and not C.resolve(v.lstrip("/").strip().lower(), self._commands()):
                self._accept_preview()
                text = self.query_one("#prompt", Input).value.strip()
        e.input.value = ""
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
            self.note("Un tour est en cours (Échap pour interrompre).", "warn")
            return
        self.busy = True
        b = UserBubble(shown or text)
        self.user_bubbles.append(b)
        self.add(b)
        self.refresh_panels()
        self.run_worker(self.sv.run_user_turn(text), exclusive=False)

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
            self.note(f"Modèle Claude Code → {sv.config.claude_model or 'défaut'}", "ok")
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
                self.note("⚠ ce modèle n'annonce pas les appels d'outils : l'agent ne pourra pas agir.", "warn")
            self.note(f"Modèle → {name}{extra}", "ok")
        self.refresh_panels()

    async def pick_model(self) -> None:
        sv = self.sv
        if sv.is_cli and sv.mode != "claude":
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
        ms = [m for m in sv.models.values() if m.chat_text and m.supports_tools]
        if not ms:
            self.note(f"Catalogue {sv.mode_label} indisponible ou vide (clé ? réseau ? /connect).", "warn")
            return
        fav = set(sv.config.favorite_models)
        rec = {m: i for i, m in enumerate(sv.config.recent_models)}

        def det(m):
            price = f"${m.prompt_price * 1e6:.2f}/${m.completion_price * 1e6:.2f} /Mtok" if m.prompt_price is not None else "prix indisponible"
            ef = variants.effort_param(m.params)
            return f"ctx {m.context_length // 1000 if m.context_length else '?'}k · {price}" + (f" · effort {'/'.join(ef.choices)}" if ef else "")

        ordered = sorted(ms, key=lambda m: (m.id not in fav, rec.get(m.id, 99), m.id))
        items = [((("★ " if m.id in fav else "") + m.id), m.id, det(m)) for m in ordered]

        def toggle_fav(mid):
            if mid in sv.config.favorite_models:
                sv.config.favorite_models.remove(mid)
            else:
                sv.config.favorite_models.append(mid)
            save_config(sv.config)
            self.notify(f"Favoris : {', '.join(sv.config.favorite_models) or 'aucun'}")

        v = await self.app.push_screen_wait(PickerScreen("Modèles Poe (chat + outils)", items, "↑↓ · Entrée choisir · Ctrl+F favori · Échap",
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
        c = C.resolve(cmd, self._commands())
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

    async def cmd_sessions(self, arg):
        ss = list_sessions()
        items = [(f"{s.id}  {datetime.fromtimestamp(s.updated):%d/%m %H:%M}  {Path(s.workspace).name}", s.id, f"{s.title or s.model or s.mode}") for s in ss[:50]]
        v = await self.app.push_screen_wait(PickerScreen("Sessions", items, current=self.sv.session.id))
        if v and v != self.sv.session.id:
            await self.app.switch(None, v)

    async def cmd_models(self, arg):
        await self.pick_model()

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
        self.note(f"↶ Message annulé{files}. /redo pour rétablir.", "ok" if r["git"] else "warn")
        inp = self.query_one("#prompt", Input)
        inp.value = r["text"]
        inp.cursor_position = len(inp.value)
        self.refresh_panels()

    async def cmd_redo(self, arg):
        r = self.sv.redo()
        if r is None:
            self.note("Rien à rétablir (disponible seulement après /undo).", "warn")
            return
        self.note(f"↷ Message rétabli — {len(r['files'])} fichier(s) restauré(s)." if r["git"] else "↷ Message rétabli (fichiers non gérés hors Git).", "ok")
        self.query_one("#prompt", Input).value = ""
        self.refresh_panels()

    async def cmd_editor(self, arg):
        editor = os.environ.get("EDITOR") or os.environ.get("VISUAL") or next((e for e in ("nano", "vim", "vi", "notepad") if shutil.which(e)), None)
        if not editor:
            self.note("Aucun éditeur : définissez la variable EDITOR.", "error")
            return
        inp = self.query_one("#prompt", Input)
        with tempfile.NamedTemporaryFile("w+", suffix=".md", delete=False, encoding="utf-8") as f:
            f.write(inp.value)
            path = f.name
        try:
            with self.app.suspend():
                subprocess.run([*shlex.split(editor), path])
            inp.value = " ".join(Path(path).read_text(encoding="utf-8").split("\n")).strip()
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
            r = subprocess.run([self.sv.config.claude_bin, "--version"], capture_output=True, text=True, timeout=10)
            lines.append(f"Claude Code : {r.stdout.strip() or r.stderr.strip()}  (mise à jour : `claude update` dans un terminal)")
        except Exception:  # noqa: BLE001
            lines.append("Claude Code : introuvable")
        await self.app.push_screen_wait(InfoScreen("Versions", Text("\n".join(lines))))

    async def cmd_connect(self, arg):
        """Connexions : fournisseurs API (clé d'API) et agents IA détectés sur l'ordinateur."""
        sv = self.sv
        items: list[tuple[str, str, str]] = []
        found = detect()
        for d in sorted(found, key=lambda d: not d.installed):
            a = d.adapter
            st = f"détecté ✓ {d.path}" if d.installed else "non installé"
            items.append((("◆ " if d.installed else "◇ ") + a.label + ("  (agent installé)" if d.installed else ""), f"cli:{a.id}", f"{st} · {a.verified}"))
        for s in all_specs():
            st = ("clé enregistrée ✓" if has_credentials(s) else "clé à saisir") if s.key_required else "local, sans clé"
            items.append((s.label + "  (API)", f"api:{s.id}", f"{st} · {s.verified}"))
        items.append(("＋ Autre fournisseur (URL compatible OpenAI)…", "__custom__", "nom + adresse + clé"))
        v = await self.app.push_screen_wait(PickerScreen("Connexions — agents installés et fournisseurs API", items, current=("api:" + sv.mode) if not sv.is_cli else sv.mode,
                                                         hint="Entrée : se connecter · les clés sont stockées dans " + credentials.storage_kind()))
        if not v:
            return
        if v == "__custom__":
            return await self._connect_custom()
        kind, _, ident = v.partition(":")
        if kind == "cli":
            return await self.cmd_provider(ident)
        await self._connect_api(ident)

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
        self.note(("✓ " if ok else "✗ ") + msg, "ok" if ok else "error")
        if ok:
            self.refresh_panels()
            if not sv.session.model:
                await self.pick_model()

    async def _connect_custom(self) -> None:
        name = await self.app.push_screen_wait(TextPromptScreen("Nom court du fournisseur (ex. monserveur)"))
        if not name:
            return
        url = await self.app.push_screen_wait(TextPromptScreen("Adresse de base de l'API compatible OpenAI (ex. https://exemple.com/v1)"))
        if not url or not url.startswith(("http://", "https://")):
            self.note("Adresse invalide (http:// ou https:// attendu).", "error")
            return
        local = url.startswith(("http://localhost", "http://127.0.0.1"))
        pid = "".join(ch for ch in name.lower() if ch.isalnum() or ch in "-_") or "custom"
        save_custom(ProviderSpec(pid, name, url, f"{pid.upper().replace('-', '_')}_API_KEY", key_required=not local, custom=True))
        await self._connect_api(pid)

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
        self.note(f"Mode → {arg}" + (f" ⚠ {w}" if w else ""), "ok")
        self.refresh_panels()

    async def cmd_agents(self, arg):
        sv = self.sv
        items = [(n + (" (sous-agent)" if not m.primary else ""), n, f"{m.scope} · {m.description}" + (" · lecture seule" if m.readonly else "")) for n, m in sv.ext.modes.items()]
        v = await self.app.push_screen_wait(PickerScreen("Modes / agents (Tab pour alterner)", items, current=sv.session.agent))
        if v:
            await self.cmd_mode(v)

    async def cmd_effort(self, arg):
        """/effort : niveau d'effort du modèle ACTIF (valeurs lues du catalogue ; Claude Code : low…max)."""
        sv = self.sv
        p = variants.effort_param(sv.model_params())
        if not p:
            self.note(f"{sv.model_key or 'ce modèle'} ne propose pas de réglage d'effort (voir /options pour ses autres réglages).", "warn")
            return
        if not arg:
            cur = sv.current_options().get(p.name)
            items = [("défaut du modèle", "__default__", f"défaut : {p.default}" if p.default else "valeur par défaut du fournisseur")] + [(c, c, "") for c in p.choices]
            v = await self.app.push_screen_wait(PickerScreen(f"Effort — {p.name} ({sv.model_key})", items, current=cur or "__default__"))
            if v is None:
                return
            arg = "défaut" if v == "__default__" else v
        try:
            sv.set_option(p.name, None if arg in ("défaut", "default") else variants.coerce(p, arg))
            self.note(f"Effort ({p.name}) → {arg}", "ok")
        except ValueError as ex:
            self.note(f"Valeur invalide : {ex}", "error")
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
            lines = [f"{'✓' if F.status(h)[0] else '✗'} {h.id}  {h.label}  ({F.status(h)[1]})" for h in (F.parse_helper(x) for x in cfg.fusion_helpers) if h]
            self.note(f"Fusion {'ACTIVÉE' if cfg.fusion_enabled else 'désactivée'} · max {cfg.fusion_max_calls}/tour\n" + ("\n".join(lines) or "aucun assistant"))
            return
        # sélecteur interactif
        while True:
            items = [(f"Mode fusion : {'ACTIVÉ' if cfg.fusion_enabled else 'désactivé'}", "__toggle__", "Entrée pour basculer")]
            for hid in cfg.fusion_helpers:
                h = F.parse_helper(hid)
                if h:
                    ok, why = F.status(h)
                    items.append((("✓ " if ok else "✗ ") + h.label, f"rm:{hid}", f"{hid} · {why} · Entrée : retirer"))
            items += [("＋ Ajouter un agent installé…", "__cli__", ""), ("＋ Ajouter un modèle d'une API connectée…", "__api__", "")]
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
                          ("détecté ✓" if d.installed else "non installé") + " · " + d.adapter.verified) for d in detect()]
                pick = await self.app.push_screen_wait(PickerScreen("Ajouter un agent", [c for c in cands if c[1] not in cfg.fusion_helpers]))
                if pick:
                    await self.cmd_fusion(f"add {pick}")
                    cfg.fusion_enabled = True
                    commit("Mode fusion activé.")
            elif v == "__api__":
                specs = [(sp.label, sp.id, "clé ✓" if has_credentials(sp) else "clé absente") for sp in all_specs() if has_credentials(sp)]
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
        self.note("⚠ BYPASS " + ("TOTAL " if total else "") + "activé — /bypass off pour revenir.", "warn")
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
        t.add_row("Agents détectés", ", ".join(f"{d.adapter.label}{' ✓' if d.installed else ''}" for d in detect() if d.installed) or "aucun")
        t.add_row("Mode / agent", sv.session.agent)
        t.add_row("Modèle", (sv.config.claude_model or "défaut") if sv.mode == "claude" else (sv.config.cli_models.get(sv.mode[4:], "défaut de l'agent") if sv.is_cli else (sv.session.model or "—")))
        t.add_row("Réglages", variants.summary(sv.model_params(), sv.current_options()) or "(défauts du modèle)")
        t.add_row("Projet", str(sv.ctx.workspace.root) + (f"  ⎇ {self.branch}" if self.branch else ""))
        t.add_row("Annuler Git", "disponible" if sv.snap.available else "indisponible (pas un dépôt Git)")
        t.add_row("MCP", "; ".join(f"{m['name']}: {m['state']} ({m['tools']})" for m in sv.mcp.status()) or "aucun")
        t.add_row("Skills", ", ".join(sv.ext.skills) or "aucun")
        t.add_row("Plugins", ", ".join(f"{p.name}{'✓' if p.loaded else ('⚠' + (p.error or '') if p.trusted else ' (non approuvé)')}" for p in sv.ext.plugins.plugins.values()) or "aucun")
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
            st = "chargé ✓" if p.loaded else (f"erreur : {p.error}" if p.error else ("approuvé" if p.trusted else "NON approuvé → /plugins trust " + p.name))
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

    async def cmd_define_token(self, arg):
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
        try:
            self.sv.config.points_per_usd = float(arg.replace(",", "."))
            save_config(self.sv.config)
            self.note(f"Taux saisi manuellement : {self.sv.config.points_per_usd:g} points/USD (les estimations en dépendent).", "ok")
        except ValueError:
            self.note("Usage : /rate 30000", "error")
        self.refresh_panels()

    async def cmd_spent(self, arg):
        try:
            self.sv.budget.add_manual(self.sv.session.id, float(arg.replace(",", ".")))
            self.note("Dépense saisie à la main enregistrée [saisi].", "ok")
        except ValueError:
            self.note("Usage : /spent 12.5", "error")
        self.refresh_panels()


# ======================================================================= palette de commandes (Ctrl+P)
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
        self.theme = cfg.theme if cfg.theme in self.available_themes else "eclipse"
        if self._path or self._resume:
            self.open_project(self._path, self._resume)
        else:
            self.push_screen(HomeScreen())

    def open_project(self, path: str | None, resume: str | None) -> None:
        cfg = load_config()
        try:
            self.sv = create_services(path or ".", resume=resume, config=cfg, provider=self._provider)
        except Exception as e:  # noqa: BLE001
            self.notify(f"Ouverture impossible : {e}", severity="error")
            return
        while len(self.screen_stack) > 1:
            self.pop_screen()
        self.push_screen(WorkScreen(self.sv))

    async def switch(self, path: str | None, resume: str | None) -> None:
        old = self.sv
        if old:
            await old.close()
        self.open_project(path, resume)

    async def action_quit(self) -> None:
        if self.sv:
            await self.sv.close()
        self.exit()
