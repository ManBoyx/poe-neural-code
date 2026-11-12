"""Modes (profils d'agent) : build (tout), plan (lecture seule), et personnalisés (Markdown). Tab / Maj+Tab pour alterner.

Un mode combine un prompt système, des outils permis, et (option) un modèle préféré. `plan` est appliqué par le code (outils de
modification refusés), pas seulement demandé au modèle. Fichiers : .eclipse/modes/*.md, .opencode/agents/*.md, .claude/agents/*.md et
équivalents globaux (corps = prompt système ; en-tête : description, mode primary|subagent, model, readonly, tools).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .frontmatter import parse

READONLY_TOOLS = {"list_dir", "read_file", "search_files", "todo_write", "memory_search", "memory_load", "memory_note", "skill", "ask_helper"}
PROJECT_DIRS = (".eclipse/modes", ".opencode/agents", ".claude/agents")
GLOBAL_DIRS = ("~/.config/eclipse/modes", "~/.config/opencode/agents", "~/.claude/agents")


@dataclass
class Mode:
    name: str
    description: str = ""
    system: str = ""
    readonly: bool = False
    tools_allow: set[str] | None = None
    tools_deny: set[str] = field(default_factory=set)
    model: str | None = None
    scope: str = "builtin"
    primary: bool = True

    def allows(self, tool_name: str) -> bool:
        if tool_name in self.tools_deny:
            return False
        if self.readonly and tool_name not in READONLY_TOOLS:
            return False
        if self.tools_allow is not None and tool_name not in self.tools_allow and tool_name not in ("todo_write",):
            return False
        return True


BUILTIN = {
    "build": Mode("build", "Agent complet : lit, modifie, exécute (avec vos autorisations)", "", scope="builtin"),
    "plan": Mode("plan", "Lecture seule : analyse et propose un plan, ne modifie rien",
                 "You are in PLAN mode: analyse the code and propose a concrete step-by-step plan. You cannot edit files or run commands "
                 "(those tools are disabled). Use read-only tools, todo_write for the plan, and ask questions if needed.", readonly=True, scope="builtin"),
}


def load_modes(root: Path, home: Path | None = None) -> dict[str, Mode]:
    home = home or Path.home()
    modes = dict(BUILTIN)
    dirs = [(root / d, "project") for d in PROJECT_DIRS] + [(Path(d.replace("~", str(home), 1)), "global") for d in GLOBAL_DIRS]
    for base, scope in dirs:
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*.md")):
            name = str(f.relative_to(base).with_suffix("")).replace("\\", "/")
            if name in modes:
                continue
            try:
                fields, body, raw = parse(f.read_text(encoding="utf-8"))
            except OSError:
                continue
            deny_edit_shell = bool(re.search(r"action:\s*edit", raw) and re.search(r"action:\s*shell", raw) and raw.count("effect: deny") >= 2)
            tools = {t.strip() for t in fields.get("tools", "").split(",") if t.strip()}
            modes[name] = Mode(name, fields.get("description", ""), body, readonly=fields.get("readonly", "").lower() == "true" or deny_edit_shell,
                               tools_allow=tools or None, model=fields.get("model") or None, scope=scope,
                               primary=fields.get("mode", "primary") != "subagent")
    return modes


def cycle(modes: dict[str, Mode], current: str, step: int = 1) -> str:
    names = [n for n, m in modes.items() if m.primary]
    if current not in names:
        return names[0]
    return names[(names.index(current) + step) % len(names)]
