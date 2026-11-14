"""Widgets de conversation : messages en blocs (style OpenCode)."""
from __future__ import annotations

from rich.syntax import Syntax
from rich.text import Text
from textual import events
from textual.message import Message
from textual.widgets import Input, Markdown, Static, TextArea

from . import icons as I


class UserBubble(Static):
    DEFAULT_CSS = """
    UserBubble { border-left: thick $accent; background: $panel; padding: 0 1; margin: 1 0 0 0; color: $text; }
    """

    def __init__(self, text: str):
        super().__init__(Text(text))
        self.text = text


class AssistantAnswer(Markdown):
    """Réponse du modèle rendue en Markdown ; mise à jour limitée en cadence pendant le flux."""
    DEFAULT_CSS = """
    AssistantAnswer { margin: 1 0 0 0; padding: 0 2 0 2; background: transparent; }
    AssistantAnswer > MarkdownBlock { margin: 0 0 1 0; }
    """

    def __init__(self, text: str = ""):
        super().__init__(text)
        self.buffer = text
        self._pending = False

    def append(self, chunk: str) -> None:
        self.buffer += chunk
        if not self._pending:
            self._pending = True
            self.set_timer(0.08, self._flush)

    def _flush(self) -> None:
        self._pending = False
        self.update(self.buffer)

    def finish(self, final: str | None = None) -> None:
        if final is not None:
            self.buffer = final
        self.update(self.buffer)


class ThinkingBlock(Static):
    DEFAULT_CSS = """
    ThinkingBlock { color: $text-muted; text-style: italic; border-left: tall $primary 40%; padding: 0 1; margin: 1 0 0 2; display: none; }
    ThinkingBlock.visible { display: block; }
    """

    def __init__(self):
        super().__init__("")
        self.buffer = ""

    def append(self, chunk: str) -> None:
        self.buffer += chunk
        self.update(Text(I.get("thinking") + " " + self.buffer[-1500:]))


READ_ONLY = {"read_file", "list_dir", "search_files", "memory_search", "memory_load", "skill", "todo_write", "web_fetch"}


class ToolBlock(Static):
    """Bloc d'outil : en-tête (icône, outil, résumé, état) ; sortie repliable d'un clic (repliée par défaut pour les lectures)."""
    DEFAULT_CSS = """
    ToolBlock { margin: 0 0 0 2; padding: 0 1; border-left: tall $secondary 60%; color: $text-muted; }
    ToolBlock:hover { background: $boost; }
    ToolBlock.ok { border-left: tall $success; }
    ToolBlock.fail { border-left: tall $error; }
    ToolBlock.pending { border-left: tall $warning; }
    """

    def __init__(self, name: str, summary: str):
        super().__init__("")
        self.tool, self.summary = name, summary
        self.state, self.output, self.details = "pending", "", name not in READ_ONLY
        self.add_class("pending")
        self._refresh_text()

    def finish(self, ok: bool, output: str) -> None:
        self.state, self.output = ("ok" if ok else "fail"), output
        if not ok:
            self.details = True  # une erreur se montre toujours
        self.remove_class("pending")
        self.add_class(self.state)
        self._refresh_text()

    def set_details(self, on: bool) -> None:
        self.details = on
        self._refresh_text()

    def _refresh_text(self) -> None:
        mark = {"pending": I.get("clock"), "ok": I.get("ok"), "fail": I.get("error")}[self.state]
        t = Text()
        t.append(f"{I.tool(self.tool)} {self.tool}", style="bold")
        t.append(f"  {self.summary[:160]}  ", style="dim")
        t.append(mark, style={"pending": "yellow", "ok": "green", "fail": "red"}[self.state])
        if self.output and not self.details:
            n = len(self.output.splitlines())
            t.append(f"  {I.get('chevron')} {n} ligne{'s' if n > 1 else ''} (clic pour voir)", style="dim italic")
        if self.output and self.details:
            lines = self.output.splitlines()
            shown = lines[:10]
            t.append("\n" + "\n".join(shown), style="dim" if self.state == "ok" else "red")
            if len(lines) > 10:
                t.append(f"\n… {len(lines) - 10} lignes de plus", style="dim italic")
        self.update(t)


    def on_click(self) -> None:
        self.details = not self.details
        self._refresh_text()


class TurnFooter(Static):
    """Pied de tour : durée, tokens, coût — avec la nature de chaque valeur."""
    DEFAULT_CSS = "TurnFooter { margin: 0 0 0 2; color: $text-muted; text-style: italic; }"


class WelcomeCard(Static):
    DEFAULT_CSS = """
    WelcomeCard { margin: 1 2; padding: 1 2; border: round $primary 50%; background: $surface; height: auto; }
    """


class PromptArea(TextArea):
    """Saisie multiligne : Entrée envoie · Maj+Entrée / Ctrl+J / Alt+Entrée = nouvelle ligne · ↑/↓ en bord = historique.
    Compatible avec l'ancien champ (propriété `value`, `action_submit`, `cursor_position`)."""
    DEFAULT_CSS = """
    PromptArea { height: auto; min-height: 3; max-height: 12; border: round $primary 60%; background: $surface; padding: 0 1; }
    PromptArea:focus { border: round $primary; }
    PromptArea .text-area--cursor-line { background: transparent; }
    """

    class Submitted(Message):
        def __init__(self, area: "PromptArea", value: str):
            super().__init__()
            self.input, self.value = area, value

        @property
        def control(self):
            return self.input

    def __init__(self, placeholder: str = "", id: str | None = None):
        super().__init__("", id=id, soft_wrap=True, tab_behavior="focus", show_line_numbers=False, highlight_cursor_line=False, placeholder=placeholder)
        self.prompt_history: list[str] = []
        self._hpos: int | None = None

    @property
    def value(self) -> str:
        return self.text

    @value.setter
    def value(self, v: str) -> None:
        self.text = v
        self.move_cursor((self.document.line_count - 1, len(self.document.get_line(self.document.line_count - 1))))

    @property
    def cursor_position(self) -> int:
        return len(self.text)

    @cursor_position.setter
    def cursor_position(self, _v: int) -> None:
        self.move_cursor((self.document.line_count - 1, len(self.document.get_line(self.document.line_count - 1))))

    async def action_submit(self) -> None:
        self.post_message(self.Submitted(self, self.text))

    def remember(self, text: str) -> None:
        if text.strip() and (not self.prompt_history or self.prompt_history[-1] != text):
            self.prompt_history.append(text)
        self._hpos = None

    async def _on_key(self, event: events.Key) -> None:
        scr = self.screen
        if getattr(scr, "leader_active", False):
            event.stop()
            event.prevent_default()
            if event.key in getattr(scr, "leader_keys", {}):
                scr.action_leader_do(event.key)
            else:
                scr._leader_off()
            return
        if event.key == "enter":
            event.stop()
            event.prevent_default()
            await self.action_submit()
            return
        if event.key in ("shift+enter", "ctrl+j", "alt+enter"):
            event.stop()
            event.prevent_default()
            self.insert("\n")
            return
        row = self.cursor_location[0]
        if event.key == "up" and row == 0 and self.prompt_history:
            event.stop()
            event.prevent_default()
            self._hpos = len(self.prompt_history) - 1 if self._hpos is None else max(0, self._hpos - 1)
            self.value = self.prompt_history[self._hpos]
            return
        if event.key == "down" and self._hpos is not None and row == self.document.line_count - 1:
            event.stop()
            event.prevent_default()
            self._hpos += 1
            if self._hpos >= len(self.prompt_history):
                self._hpos = None
                self.value = ""
            else:
                self.value = self.prompt_history[self._hpos]
            return
        await super()._on_key(event)


class DiffBlock(Static):
    DEFAULT_CSS = "DiffBlock { margin: 0 0 0 2; padding: 0 1; background: $surface; }"

    def __init__(self, diff: str):
        super().__init__(Syntax(diff, "diff", word_wrap=True, background_color="default"))


class NoticeLine(Static):
    DEFAULT_CSS = """
    NoticeLine { margin: 0 0 0 2; color: $text-muted; }
    NoticeLine.warn { color: $warning; }
    NoticeLine.error { color: $error; text-style: bold; }
    NoticeLine.ok { color: $success; }
    """

    def __init__(self, text: str, level: str = "info"):
        super().__init__(Text(text))
        if level != "info":
            self.add_class(level)


class PromptInput(Input):
    """Champ de saisie qui laisse la touche « leader » (Ctrl+X) intercepter la lettre suivante."""

    async def _on_key(self, event: events.Key) -> None:
        scr = self.screen
        if getattr(scr, "leader_active", False):
            event.stop()
            event.prevent_default()
            if event.key in getattr(scr, "leader_keys", {}):
                scr.action_leader_do(event.key)
            else:
                scr._leader_off()
            return
        await super()._on_key(event)
