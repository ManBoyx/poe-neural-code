"""Périmètre de travail. Résolution par chemin réel (les liens symboliques ne permettent pas de s'échapper).

Ce n'est PAS une sandbox : un processus lancé par l'utilisateur via run_command garde les droits de l'utilisateur.
"""
from __future__ import annotations

import os
from pathlib import Path


class Workspace:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()

    def resolve(self, p: str | Path) -> tuple[Path, bool]:
        """(chemin absolu réel, est_dans_le_projet)."""
        path = Path(p).expanduser()
        if not path.is_absolute():
            path = self.root / path
        real = Path(os.path.realpath(path))
        return real, real == self.root or self.root in real.parents

    def rel(self, p: Path) -> str:
        try:
            return str(p.relative_to(self.root))
        except ValueError:
            return str(p)
