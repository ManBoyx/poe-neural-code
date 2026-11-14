"""Annuler / rétablir (/undo, /redo) — comme OpenCode, s'appuie sur Git pour les fichiers.

Un instantané = arbre Git de l'état du projet, calculé avec un index TEMPORAIRE : l'index, les branches et l'historique de l'utilisateur ne sont
jamais touchés, et aucun commit n'est créé. Hors dépôt Git, seule la conversation est annulée (les fichiers ne sont pas restaurés — annoncé).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


class Snapshots:
    def __init__(self, root: Path):
        self.root = Path(root)
        r = self._git("rev-parse", "--show-toplevel", check=False)
        self.top = Path(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None

    @property
    def available(self) -> bool:
        return self.top is not None

    def _git(self, *args: str, env: dict | None = None, check: bool = True, cwd: Path | None = None) -> subprocess.CompletedProcess:
        full_env = {**os.environ, **(env or {}), "GIT_OPTIONAL_LOCKS": "0"}
        try:
            return subprocess.run(["git", *args], cwd=str(cwd or self.root), env=full_env, capture_output=True, text=True, check=False)
        except OSError as e:  # dossier disparu ou git absent : instantanés indisponibles, jamais de plantage
            return subprocess.CompletedProcess(["git", *args], 127, "", str(e))

    def _tmp_env(self) -> tuple[dict, str]:
        fd, path = tempfile.mkstemp(prefix="eclipse-idx-")
        os.close(fd)
        os.unlink(path)  # git crée lui-même l'index
        return {"GIT_INDEX_FILE": path}, path

    def snapshot(self) -> str | None:
        if not self.available:
            return None
        env, path = self._tmp_env()
        try:
            self._git("add", "-A", "--", str(self.root), env=env, cwd=self.top)
            r = self._git("write-tree", env=env, cwd=self.top)
            return r.stdout.strip() or None if r.returncode == 0 else None
        finally:
            Path(path).unlink(missing_ok=True)

    def restore(self, tree: str) -> list[str]:
        """Remet le projet dans l'état de `tree`. Retourne les fichiers touchés (restaurés ou supprimés)."""
        if not self.available:
            return []
        cur = self.snapshot()
        if not cur or cur == tree:
            return []
        r = self._git("diff-tree", "-r", "--name-status", "--no-renames", cur, tree, cwd=self.top)
        touched: list[str] = []
        env, path = self._tmp_env()
        try:
            self._git("read-tree", tree, env=env, cwd=self.top)
            to_checkout: list[str] = []
            for line in r.stdout.splitlines():
                st, _, name = line.partition("\t")
                if not name:
                    continue
                if st == "D":  # présent maintenant, absent de l'état cible → supprimer
                    f = self.top / name
                    if f.is_file() or f.is_symlink():
                        f.unlink()
                        touched.append(name)
                else:  # A / M : à restaurer depuis l'état cible
                    to_checkout.append(name)
            for i in range(0, len(to_checkout), 200):
                chunk = to_checkout[i:i + 200]
                self._git("checkout-index", "-f", "--", *chunk, env=env, cwd=self.top)
                touched += chunk
        finally:
            Path(path).unlink(missing_ok=True)
        return touched
