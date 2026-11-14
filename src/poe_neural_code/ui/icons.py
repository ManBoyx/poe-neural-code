"""Icônes de l'interface — AUCUN emoji.

Source : Nerd Fonts 3.5.1 (https://www.nerdfonts.com, glyphnames.json officiel) — jeux Material Design (nf-md-*), Devicons (nf-dev-*) et Codicons (nf-cod-*).
Les icônes Nerd Font s'affichent si une police Nerd Font est installée (détection via fontconfig) ; sinon, repli sur des symboles texte simples
(jamais d'emoji). Réglable : `/config` → icons = auto | nerd | text.
"""
from __future__ import annotations

import shutil
import subprocess

# nom -> (code Nerd Font, nom officiel, repli texte)
_TABLE: dict[str, tuple[int, str, str]] = {
    "eclipse": (0xF0594, "nf-md-weather_night", "◆"),
    "project": (0xF0DCF, "nf-md-folder_open_outline", "▸"),
    "branch": (0xE725, "nf-dev-git_branch", "⎇"),
    "provider": (0xF0163, "nf-md-cloud_outline", "@"),
    "agent": (0xF167A, "nf-md-robot_outline", "@"),
    "model": (0xF061A, "nf-md-chip", "#"),
    "build": (0xF1323, "nf-md-hammer_wrench", "B"),
    "plan": (0xF0A38, "nf-md-clipboard_text_outline", "P"),
    "context": (0xF029A, "nf-md-gauge", "~"),
    "session": (0xF036A, "nf-md-message_text_outline", "§"),
    "user": (0xF0013, "nf-md-account_outline", ">"),
    "file": (0xF09EE, "nf-md-file_document_outline", "·"),
    "folder": (0xF0256, "nf-md-folder_outline", "/"),
    "search": (0xF0349, "nf-md-magnify", "?"),
    "edit": (0xF03EB, "nf-md-pencil", "~"),
    "delete": (0xF0A7A, "nf-md-trash_can_outline", "x"),
    "terminal": (0xF018D, "nf-md-console", "$"),
    "todo": (0xF0135, "nf-md-checkbox_marked_outline", "[x]"),
    "todo_open": (0xF0131, "nf-md-checkbox_blank_outline", "[ ]"),
    "todo_doing": (0xF0996, "nf-md-progress_clock", "[~]"),
    "memory": (0xF09D1, "nf-md-brain", "M"),
    "skill": (0xF1180, "nf-md-school_outline", "S"),
    "web": (0xF059F, "nf-md-web", "w"),
    "helper": (0xF000F, "nf-md-account_multiple_outline", "&"),
    "plugin": (0xF0A66, "nf-md-puzzle_outline", "+"),
    "mcp": (0xF1616, "nf-md-connection", "%"),
    "image": (0xF0976, "nf-md-image_outline", "img"),
    "attach": (0xF03E2, "nf-md-paperclip", "+"),
    "thinking": (0xF07F7, "nf-md-thought_bubble_outline", "…"),
    "warn": (0xF002A, "nf-md-alert_outline", "!"),
    "error": (0xF015A, "nf-md-close_circle_outline", "x"),
    "ok": (0xF05E1, "nf-md-check_circle_outline", "v"),
    "info": (0xF02FD, "nf-md-information_outline", "i"),
    "pause": (0xF03E6, "nf-md-pause_circle_outline", "||"),
    "stop": (0xF0667, "nf-md-stop_circle_outline", "[]"),
    "retry": (0xF0450, "nf-md-refresh", "R"),
    "clock": (0xF0150, "nf-md-clock_outline", "t"),
    "coins": (0xF0116, "nf-md-cash_multiple", "$"),
    "tokens": (0xF0199, "nf-md-counter", "#"),
    "budget": (0xF0BDD, "nf-md-wallet_outline", "$"),
    "subscription": (0xF0DAB, "nf-md-card_account_details_outline", "*"),
    "lock": (0xF0341, "nf-md-lock_outline", "[?]"),
    "bypass": (0xF099C, "nf-md-shield_off_outline", "!!"),
    "free": (0xF02A1, "nf-md-gift_outline", "0$"),
    "star": (0xF04CE, "nf-md-star", "*"),
    "settings": (0xF08BB, "nf-md-cog_outline", "*"),
    "chart": (0xF154E, "nf-md-chart_box_outline", "="),
    "calendar": (0xF01E1, "nf-md-calendar_refresh", "@"),
    "window": (0xF051F, "nf-md-timer_sand", "t"),
    "trend_up": (0xF0535, "nf-md-trending_up", "^"),
    "trend_down": (0xF0533, "nf-md-trending_down", "v"),
    "trend_flat": (0xF0534, "nf-md-trending_neutral", "="),
    "undo": (0xF054C, "nf-md-undo", "<"),
    "redo": (0xF044E, "nf-md-redo", ">"),
    "diff": (0xEAE1, "nf-cod-diff", "±"),
    "tools": (0xF1064, "nf-md-tools", "*"),
    "list": (0xF0279, "nf-md-format_list_bulleted", "-"),
    "key": (0xF0DD6, "nf-md-key_outline", "k"),
    "dot": (0xF09DE, "nf-md-circle_medium", "·"),
    "circle": (0xF0765, "nf-md-circle", "●"),
    "circle_open": (0xF0766, "nf-md-circle_outline", "○"),
    "chevron": (0xF0142, "nf-md-chevron_right", ">"),
    "expand": (0xF0140, "nf-md-chevron_down", "v"),
    "send": (0xF048A, "nf-md-send", ">"),
    "bolt": (0xF140B, "nf-md-lightning_bolt", "*"),
    "network": (0xF0317, "nf-md-lan", "~"),
}

_MODE = "text"


def nerd_font_installed() -> bool:
    if not shutil.which("fc-list"):
        return False
    try:
        out = subprocess.run(["fc-list"], capture_output=True, text=True, timeout=5).stdout
    except Exception:  # noqa: BLE001
        return False
    return "Nerd Font" in out


def configure(mode: str = "auto") -> str:
    """mode : auto | nerd | text. Retourne le mode effectif."""
    global _MODE
    _MODE = ("nerd" if nerd_font_installed() else "text") if mode == "auto" else ("nerd" if mode == "nerd" else "text")
    return _MODE


def mode() -> str:
    return _MODE


def get(name: str) -> str:
    code, _n, fallback = _TABLE[name]
    return chr(code) if _MODE == "nerd" else fallback


def names() -> dict[str, tuple[int, str, str]]:
    return dict(_TABLE)


TOOL_ICON = {"read_file": "file", "list_dir": "folder", "search_files": "search", "write_file": "edit", "edit_file": "edit", "delete_file": "delete",
             "run_command": "terminal", "todo_write": "todo", "memory_search": "memory", "memory_load": "memory", "memory_note": "memory", "skill": "skill",
             "web_fetch": "web", "ask_helper": "helper"}


def tool(name: str) -> str:
    if name.startswith("mcp__"):
        return get("mcp")
    return get(TOOL_ICON.get(name, "plugin" if "_" in name and name.split("_")[0] not in TOOL_ICON else "tools"))
