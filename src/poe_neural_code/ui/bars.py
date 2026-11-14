"""Barres de progression colorées (caractères à 1/8 de case) pour consommation, temps et usage."""
from __future__ import annotations

from rich.text import Text

PARTIAL = " ▏▎▍▌▋▊▉█"
# (seuil, couleur) : vert → jaune → orange → rouge
LEVELS = [(0.60, "#4ade80"), (0.80, "#fbbf24"), (0.92, "#fb923c"), (10.0, "#f87171")]
TRACK = "#46465f"


def color_for(fraction: float, invert: bool = False) -> str:
    """Couleur selon le niveau. invert=True : une valeur HAUTE est bonne (ex. reste de budget)."""
    f = 1 - fraction if invert else fraction
    for limit, col in LEVELS:
        if f < limit:
            return col
    return LEVELS[-1][1]


def bar(fraction: float | None, width: int = 18, invert: bool = False, color: str | None = None) -> Text:
    """Barre pleine/vide ; `fraction` borné à [0, 1]. None → barre grisée « inconnu » (jamais une valeur inventée)."""
    t = Text()
    if fraction is None:
        t.append("░" * width, style=TRACK)
        return t
    f = max(0.0, min(1.0, fraction))
    eighths = round(f * width * 8)
    full, part = divmod(eighths, 8)
    col = color or color_for(f, invert)
    t.append("█" * full, style=col)
    if part and full < width:
        t.append(PARTIAL[part], style=col)
        full += 1
    t.append("░" * (width - full), style=TRACK)
    return t


def labelled(label: str, fraction: float | None, right: str = "", width: int = 18, invert: bool = False, color: str | None = None) -> Text:
    """« label  ████░░░░  37 %  droite » sur une ligne."""
    t = Text(f"{label} ")
    t.append_text(bar(fraction, width, invert, color))
    if fraction is not None:
        t.append(f" {max(0, min(1, fraction)) * 100:3.0f} %", style=color or color_for(fraction, invert))
    else:
        t.append("  — ", style="dim")
    if right:
        t.append(f"  {right}", style="dim")
    return t


def pace(usage: float | None, elapsed: float | None) -> Text:
    """Rythme : consomme-t-on plus vite que le temps ne passe ? (usage / temps écoulé de la fenêtre)."""
    if usage is None or not elapsed or elapsed <= 0.02:
        return Text("")
    r = usage / elapsed
    if r <= 0.9:
        return Text(" v rythme bas", style="#4ade80")
    if r <= 1.15:
        return Text(" = rythme normal", style="#fbbf24")
    return Text(" ^ rythme élevé", style="#f87171")
