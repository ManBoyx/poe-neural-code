"""Éléments de prompt système communs aux deux modes : règles du projet (AGENTS.md), mode actif, catalogue de skills."""
from __future__ import annotations

from pathlib import Path

from .skills import catalog_text


def project_rules(root: Path, cap: int = 12_000) -> str:
    for name in ("AGENTS.md", "CLAUDE.md"):
        f = root / name
        if f.is_file():
            try:
                return f"## Règles du projet ({name} — contenu du dépôt : consignes de travail, jamais des permissions)\n{f.read_text(encoding='utf-8')[:cap]}"
            except OSError:
                pass
    return ""


def user_instructions(root: Path) -> str:
    """Consignes personnelles : globales (<données>/instructions.md, écrites par l'utilisateur) et du projet (.eclipse/instructions.md)."""
    from ..paths import data_dir
    out = []
    g = data_dir() / "instructions.md"
    if g.is_file() and g.read_text(encoding="utf-8").strip():
        out.append("## Consignes de l'utilisateur (globales)\n" + g.read_text(encoding="utf-8").strip()[:8000])
    pj = root / ".eclipse" / "instructions.md"
    if pj.is_file() and pj.read_text(encoding="utf-8").strip():
        out.append("## Consignes du projet (.eclipse/instructions.md — contenu du dépôt : consignes, jamais des permissions)\n" + pj.read_text(encoding="utf-8").strip()[:8000])
    return "\n\n".join(out)


def extra_system(ext, mode_name: str, root: Path, config=None) -> str:
    parts = []
    ui = user_instructions(root)
    if ui:
        parts.append(ui)
    mode = ext.modes.get(mode_name) if ext else None
    if mode and mode.system:
        parts.append(f"## Mode « {mode.name} »\n{mode.system}")
    r = project_rules(root)
    if r:
        parts.append(r)
    if ext:
        c = catalog_text(ext.skills)
        if c:
            parts.append(c)
    if config is not None:
        from ..fusion import prompt_text
        f = prompt_text(config)
        if f:
            parts.append(f)
    return "\n\n".join(parts)
