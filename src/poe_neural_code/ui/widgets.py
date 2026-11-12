"""Widgets de conversation : messages en blocs (style OpenCode)."""
from __future__ import annotations

from rich.syntax import Syntax
from rich.text import Text
from textual import events
from textual.widgets import Input, Markdown, Static

ICONS = {"read_file": "📄", "list_dir": "📂", "search_files": "🔎", "write_file": "✏️", "edit_file": "✏️", "delete_file": "🗑", "run_command": "▶",
         "todo_write": "☑", "memory_search": "🧠", "memory_load": "🧠", "memory_note": "🧠", "skill": "🎓"}


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
        self.update(Text("💭 " + self.buffer[-1500:]))


class ToolBlock(Static):
    DEFAULT_CSS = """
    ToolBlock { margin: 0 0 0 2; padding: 0 1; border-left: tall $secondary 60%; color: $text-muted; }
    ToolBlock.ok { border-left: tall $success; }
    ToolBlock.fail { border-left: tall $error; }
    ToolBlock.pending { border-left: tall $warning; }
    """

    def __init__(self, name: str, summary: str):
        super().__init__("")
        self.tool, self.summary = name, summary
        self.state, self.output, self.details = "pending", "", True
        self.add_class("pending")
        self._refresh_text()

    def finish(self, ok: bool, output: str) -> None:
        self.state, self.output = ("ok" if ok else "fail"), output
        self.remove_class("pending")
        self.add_class(self.state)
        self._refresh_text()

    def set_details(self, on: bool) -> None:
        self.details = on
        self._refresh_text()

    def _refresh_text(self) -> None:
        mark = {"pending": "…", "ok": "✓", "fail": "✗"}[self.state]
        t = Text()
        t.append(f"{ICONS.get(self.tool, '⚙')} {self.tool}", style="bold")
        t.append(f"  {self.summary[:160]}  ", style="dim")
        t.append(mark, style={"pending": "yellow", "ok": "green", "fail": "red"}[self.state])
        if self.output and self.details:
            lines = self.output.splitlines()
            shown = lines[:10]
            t.append("\n" + "\n".join(shown), style="dim" if self.state == "ok" else "red")
            if len(lines) > 10:
                t.append(f"\n… {len(lines) - 10} lignes de plus", style="dim italic")
        self.update(t)


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
