"""Périmètre de travail. Résolution par chemin réel (les liens symboliques ne permettent pas de s'échapper).

Ce n'est PAS une sandbox : un processus lancé par l'utilisateur via run_command garde les droits de l'utilisateur.
"""
from __future__ import annotations

import os
from pathlib import Path


class Workspace:
    def __init__(self, root: str | Path, extra: list[str | Path] | None = None):
        self.root = Path(root).expanduser().resolve()
        self.extra: list[Path] = [Path(e).expanduser().resolve() for e in (extra or [])]  # /add-dir : dossiers autorisés en plus

    def roots(self) -> list[Path]:
        return [self.root, *self.extra]

    def add(self, p: str | Path) -> Path:
        d = Path(p).expanduser().resolve()
        if not d.is_dir():
            raise NotADirectoryError(str(d))
        if d not in self.roots():
            self.extra.append(d)
        return d

    def resolve(self, p: str | Path) -> tuple[Path, bool]:
        """(chemin absolu réel, est_dans_un_dossier_autorisé)."""
        path = Path(p).expanduser()
        if not path.is_absolute():
            path = self.root / path
        real = Path(os.path.realpath(path))
        return real, any(real == r or r in real.parents for r in self.roots())

    def rel(self, p: Path) -> str:
        try:
            return str(p.relative_to(self.root))
        except ValueError:
            return str(p)
