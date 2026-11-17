"""Fenêtres modales : autorisation (aperçu), sélecteurs filtrables, aide, saisie, /define-token."""
from __future__ import annotations

from typing import Any, Callable

from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, OptionList, Select, Static, Switch
from textual.widgets.option_list import Option

from ..budget import Budget
from ..tools.permissions import PermissionRequest
from . import icons as I
from .util import parse_duration

KIND_TITLE = {"fusion": "Consulter un autre assistant", "exec": "Commande à exécuter", "write": "Modification de fichier", "delete": "Suppression", "mcp": "Outil MCP",
              "skill": "Skill du projet", "plugin": "Outil de plugin", "outside": "Hors du projet", "read": "Lecture"}


class PermissionScreen(ModalScreen[str]):
    """Aperçu AVANT exécution : la commande complète, le diff, les avertissements."""
    BINDINGS = [Binding("o,enter", "decide('once')", "Autoriser une fois"), Binding("a", "decide('session')", "Pour la session"),
                Binding("n,escape", "decide('deny')", "Refuser")]
    DEFAULT_CSS = """
    PermissionScreen { align: center middle; background: $background 70%; }
    #perm { width: 90%; max-width: 120; height: auto; max-height: 85%; border: round $warning; background: $surface; padding: 1 2; }
    #perm.danger { border: round $error; }
    #perm-title { text-style: bold; }
    #perm-detail { height: auto; max-height: 24; border: round $primary 40%; margin: 1 0; padding: 0 1; background: $background; }
    #perm-buttons { height: 3; align-horizontal: right; }
    #perm-buttons Button { margin-left: 1; }
    """

    def __init__(self, req: PermissionRequest):
        super().__init__()
        self.req = req

    def compose(self) -> ComposeResult:
        r = self.req
        with Vertical(id="perm", classes="danger" if (r.destructive or r.outside) else ""):
            yield Label(Text(f"{I.get('lock')} {KIND_TITLE.get(r.kind, r.kind)} — {r.summary}"), id="perm-title")
            if r.warnings:
                yield Static(Text(I.get("warn") + " " + " · ".join(r.warnings), style="bold red" if r.destructive or r.outside else "yellow"))
            if r.detail:
                body: Any = (Syntax(r.detail, "diff", word_wrap=True, background_color="default") if r.kind == "write" else
                             Syntax(r.detail, "bash", word_wrap=True, background_color="default") if r.kind == "exec" else Text(r.detail))
                yield VerticalScroll(Static(body), id="perm-detail")
            sticky = not (r.outside or r.destructive)
            with Horizontal(id="perm-buttons"):
                yield Button("Refuser [n]", id="deny", variant="error")
                if sticky:
                    yield Button("Pour la session [a]", id="session", variant="primary")
                yield Button("Autoriser une fois [o]", id="once", variant="success")

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.dismiss(e.button.id or "deny")

    def action_decide(self, d: str) -> None:
        if d == "session" and (self.req.outside or self.req.destructive):
            return
        self.dismiss(d)


class PickerScreen(ModalScreen[Any]):
    """Sélecteur filtrable générique. items = [(libellé, valeur, détail)] ; valeur None = titre de section (non sélectionnable,
    masqué pendant un filtrage). `on_highlight` permet un aperçu en direct (thèmes)."""
    BINDINGS = [Binding("escape", "cancel", "Fermer")]
    DEFAULT_CSS = """
    PickerScreen { align: center middle; background: $background 60%; }
    #picker { width: 80%; max-width: 110; height: 70%; border: round $primary; background: $surface; padding: 1 2; }
    #picker-title { text-style: bold; color: $primary; }
    #picker-filter { margin: 1 0; }
    #picker-list { height: 1fr; background: transparent; }
    #picker-hint { color: $text-muted; height: 1; }
    """

    def __init__(self, title: str, items: list[tuple[str, Any, str]], hint: str = "↑↓ choisir · Entrée valider · Échap fermer",
                 on_highlight: Callable[[Any], None] | None = None, current: Any = None, extra_bindings: dict[str, Callable[[Any], None]] | None = None):
        super().__init__()
        self.title_text, self.items, self.hint, self.on_hl, self.current = title, items, hint, on_highlight, current
        self.extra = extra_bindings or {}

    def compose(self) -> ComposeResult:
        with Vertical(id="picker"):
            yield Label(self.title_text, id="picker-title")
            yield Input(placeholder="Filtrer…", id="picker-filter")
            yield OptionList(id="picker-list")
            yield Static(self.hint, id="picker-hint")

    def on_mount(self) -> None:
        self._fill("")
        self.query_one("#picker-filter", Input).focus()

    def _fill(self, q: str) -> None:
        ol = self.query_one("#picker-list", OptionList)
        ol.clear_options()
        ql = q.lower()
        if ql:
            items = [it for it in self.items if it[1] is not None]
            by_label = [it for it in items if ql in it[0].lower()]
            by_detail = [it for it in items if it not in by_label and ql in it[2].lower()]
            shown = by_label + by_detail  # les correspondances sur le libellé passent avant celles de la description
        else:
            shown = list(self.items)
        for lab, val, det in shown:
            if val is None:  # titre de section
                ol.add_option(Option(Text(lab, style="bold reverse"), id=str(len(ol.options)), disabled=True))
                continue
            t = Text(lab, style="bold")
            if det:
                t.append("  " + det, style="dim")
            ol.add_option(Option(t, id=str(len(ol.options))))
        self._shown = shown
        if shown:
            first = next((i for i, it in enumerate(shown) if it[1] is not None), 0)
            idx = first if q else next((i for i, (_, v, _) in enumerate(shown) if v is not None and v == self.current), first)
            ol.highlighted = idx

    def on_input_changed(self, e: Input.Changed) -> None:
        self._fill(e.value)

    def on_key(self, e) -> None:
        ol = self.query_one("#picker-list", OptionList)
        if e.key == "down":
            ol.action_cursor_down(); e.stop()
        elif e.key == "up":
            ol.action_cursor_up(); e.stop()
        elif e.key in self.extra and ol.highlighted is not None and self._shown:
            e.stop()
            r = self.extra[e.key](self._shown[ol.highlighted][1])
            if r is not None:  # un raccourci peut fermer le sélecteur avec un résultat
                self.dismiss(r)

    def on_input_submitted(self, e: Input.Submitted) -> None:
        ol = self.query_one("#picker-list", OptionList)
        if ol.highlighted is not None and self._shown and self._shown[ol.highlighted][1] is not None:
            self.dismiss(self._shown[ol.highlighted][1])

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        if self._shown[e.option_index][1] is not None:
            self.dismiss(self._shown[e.option_index][1])

    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if self.on_hl and self._shown and e.option_index is not None and e.option_index < len(self._shown):
            self.on_hl(self._shown[e.option_index][1])

    def action_cancel(self) -> None:
        self.dismiss(None)


class TextPromptScreen(ModalScreen[str | None]):
    BINDINGS = [Binding("escape", "cancel", "Annuler")]
    DEFAULT_CSS = """
    TextPromptScreen { align: center middle; background: $background 60%; }
    #tp { width: 70%; max-width: 90; height: auto; border: round $primary; background: $surface; padding: 1 2; }
    """

    def __init__(self, title: str, value: str = "", password: bool = False):
        super().__init__()
        self.title_text, self.value, self.password = title, value, password

    def compose(self) -> ComposeResult:
        with Vertical(id="tp"):
            yield Label(self.title_text)
            yield Input(value=self.value, id="tp-input", password=self.password)

    def on_mount(self) -> None:
        self.query_one(Input).focus()

    def on_input_submitted(self, e: Input.Submitted) -> None:
        self.dismiss(e.value)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ConfirmScreen(ModalScreen[bool]):
    BINDINGS = [Binding("o,enter", "yes", "Oui"), Binding("n,escape", "no", "Non")]
    DEFAULT_CSS = """
    ConfirmScreen { align: center middle; background: $background 60%; }
    #cf { width: 80%; max-width: 110; height: auto; max-height: 85%; border: round $warning; background: $surface; padding: 1 2; }
    #cf-body { height: auto; max-height: 24; margin: 1 0; border: round $primary 40%; padding: 0 1; }
    """

    def __init__(self, title: str, body: str = "", warn: str = ""):
        super().__init__()
        self.t, self.b, self.w = title, body, warn

    def compose(self) -> ComposeResult:
        with Vertical(id="cf"):
            yield Label(Text(self.t, style="bold"))
            if self.w:
                yield Static(Text(I.get("warn") + " " + self.w, style="yellow"))
            if self.b:
                yield VerticalScroll(Static(Syntax(self.b, "python", word_wrap=True, background_color="default")), id="cf-body")
            yield Label("[o] Oui, approuver   [n] Non")

    def action_yes(self) -> None:
        self.dismiss(True)

    def action_no(self) -> None:
        self.dismiss(False)


class InfoScreen(ModalScreen[None]):
    BINDINGS = [Binding("escape,enter,q", "close", "Fermer")]
    DEFAULT_CSS = """
    InfoScreen { align: center middle; background: $background 60%; }
    #info { width: 88%; max-width: 130; height: 85%; border: round $primary; background: $surface; padding: 1 2; }
    #info-title { text-style: bold; color: $primary; }
    """

    def __init__(self, title: str, renderable: Any):
        super().__init__()
        self.t, self.r = title, renderable

    def compose(self) -> ComposeResult:
        with Vertical(id="info"):
            yield Label(self.t, id="info-title")
            yield VerticalScroll(Static(self.r))
            yield Label(Text("Échap pour fermer", style="dim"))

    def action_close(self) -> None:
        self.dismiss(None)


def help_table(commands) -> Table:
    t = Table(show_header=True, header_style="bold", expand=True, box=None, padding=(0, 1))
    t.add_column("Commande", style="bold cyan", no_wrap=True)
    t.add_column("Raccourci", style="magenta", no_wrap=True)
    t.add_column("Description")
    for c in commands:
        names = "/" + c.name + "".join(f" /{a}" for a in c.aliases)
        t.add_row(names, c.keybind, c.description)
    return t


KEYS = [("Entrée", "envoyer"), ("Échap", "interrompre l'opération en cours"), ("Tab / Maj+Tab", "changer de mode (build / plan / personnalisés)"),
        ("Ctrl+T", "alterner l'effort/variante du modèle"), ("F2", "modèle récent suivant"), ("Ctrl+P", "palette de commandes"),
        ("Ctrl+X puis lettre", "touche « leader » (voir colonne Raccourci)"), ("Ctrl+B", "barre latérale"), ("Ctrl+C", "vider la saisie / quitter (2×)"),
        ("PgHaut / PgBas", "défiler la conversation"), ("/ + lettres", "aperçu des commandes pendant la frappe"), ("@fichier", "joindre un fichier du projet"),
        ("!commande", "exécuter une commande shell (aperçu + confirmation)")]


def keys_table() -> Table:
    t = Table(show_header=False, box=None, padding=(0, 1))
    for k, d in KEYS:
        t.add_row(Text(k, style="bold magenta"), d)
    return t


class DefineTokenScreen(ModalScreen[dict | None]):
    BINDINGS = [Binding("escape", "cancel", "Annuler")]
    DEFAULT_CSS = """
    DefineTokenScreen { align: center middle; background: $background 60%; }
    #dt { width: 80%; max-width: 90; height: 90%; border: round $primary; background: $surface; padding: 1 2; }
    #dt Input, #dt Select { margin-bottom: 1; }
    #dt-buttons { height: 3; }
    #dt-buttons Button { margin-right: 1; }
    #dt-error { color: $error; height: auto; }
    """

    def __init__(self, budget: Budget):
        super().__init__()
        self.budget = budget

    def compose(self) -> ComposeResult:
        cur = next((e for e in self.budget.envelopes() if e.kind == "temporary"), None)
        with VerticalScroll(id="dt"):
            yield Label(Text("/define-token — budget LOCAL (n'ajoute aucun point chez le fournisseur)", style="bold"))
            yield Label("Montant du budget en points (prioritaire)")
            yield Input(value=str(int(cur.amount_points)) if cur and cur.amount_points is not None else "600", id="amount")
            yield Label("Limite en tokens, distincte (vide = aucune)")
            yield Input(value=str(cur.token_limit) if cur and cur.token_limit else "", id="tokens")
            yield Label("Période de renouvellement (30m, 2h, 1d ; 0 = aucun)")
            yield Input(value=f"{int(cur.period_s // 60)}m" if cur and cur.period_s else "30m", id="period")
            yield Label("Portée")
            yield Select([("Partagé entre tous les modèles", "all"), ("Modèle courant seulement", "current")], value="all", id="scope", allow_blank=False)
            yield Label("Comportement à épuisement")
            yield Select([("Mettre en pause les nouvelles requêtes", "pause"), ("Avertir seulement", "warn")],
                         value=cur.on_exhaust if cur else "pause", id="exhaust", allow_blank=False)
            with Horizontal():
                yield Label("Reporter le reliquat au renouvellement ")
                yield Switch(value=bool(cur and cur.carry_over), id="carry")
            yield Static("", id="dt-error")
            with Horizontal(id="dt-buttons"):
                yield Button("Appliquer", id="apply", variant="success")
                yield Button("Supprimer ce budget", id="clear", variant="warning")
                yield Button("Annuler", id="cancel")

    def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "cancel":
            self.dismiss(None)
        elif e.button.id == "clear":
            self.dismiss({"clear": True})
        else:
            try:
                amount = self.query_one("#amount", Input).value.strip()
                tokens = self.query_one("#tokens", Input).value.strip()
                out = {"amount_points": float(amount.replace(",", ".")) if amount else None,
                       "token_limit": int(tokens) if tokens else None,
                       "period_s": parse_duration(self.query_one("#period", Input).value),
                       "scope": self.query_one("#scope", Select).value, "on_exhaust": self.query_one("#exhaust", Select).value,
                       "carry_over": self.query_one("#carry", Switch).value}
                if out["amount_points"] is None and out["token_limit"] is None:
                    raise ValueError("indiquez un montant en points et/ou une limite en tokens")
                if (out["amount_points"] or 1) <= 0 or (out["token_limit"] or 1) <= 0:
                    raise ValueError("les montants doivent être positifs")
            except ValueError as ex:
                self.query_one("#dt-error", Static).update(f"Entrée invalide : {ex}")
                return
            self.dismiss(out)

    def action_cancel(self) -> None:
        self.dismiss(None)
