"""Thèmes d'Eclipse (en plus des thèmes intégrés de Textual : nord, gruvbox, tokyo-night, catppuccin…)."""
from __future__ import annotations

from textual.theme import Theme

ECLIPSE = Theme(name="eclipse", primary="#a78bfa", secondary="#22d3ee", accent="#f0abfc", foreground="#e6e6ef", background="#09090f",
                surface="#10101a", panel="#171724", success="#4ade80", warning="#fbbf24", error="#f87171", dark=True,
                variables={"block-cursor-text-style": "none", "footer-key-foreground": "#a78bfa", "input-selection-background": "#a78bfa 35%"})
ECLIPSE_LIGHT = Theme(name="eclipse-light", primary="#6d28d9", secondary="#0e7490", accent="#a21caf", foreground="#1f1b2e", background="#f7f5fb",
                      surface="#ffffff", panel="#ece8f6", success="#15803d", warning="#b45309", error="#b91c1c", dark=False)
CUSTOM = [ECLIPSE, ECLIPSE_LIGHT]
