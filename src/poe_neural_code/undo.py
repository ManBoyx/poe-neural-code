"""Annuler / rétablir (/undo, /redo) — comme OpenCode, s'appuie sur Git pour les fichiers.

Un instantané = arbre Git de l'état du projet, calculé avec un index TEMPORAIRE : l'index, les branches et l'historique de l'utilisateur ne sont
jamais touchés, et aucun commit n'est créé.

Hors dépôt Git (ex. dossier d'une « nouvelle discussion »), un dépôt FANTÔME est utilisé s'il est fourni : il vit dans les données
d'Eclipse (jamais dans le dossier de l'utilisateur), ignore les dossiers lourds, et n'est activé que pour un dossier de taille
raisonnable. Sinon, seule la conversation est annulée (annoncé).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


SHADOW_IGNORE = ("node_modules/", ".venv/", "venv/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", "dist/", "build/", "target/",
                 ".gradle/", ".idea/", ".git/", "*.pyc")
SHADOW_MAX_FILES = 20_000
SHADOW_MAX_BYTES = 300 * 1024 * 1024
_HEAVY = {d.rstrip("/") for d in SHADOW_IGNORE if d.endswith("/")}


def small_enough(root: Path, max_files: int | None = None, max_bytes: int | None = None) -> bool:
    """Le dossier se prête-t-il à un dépôt fantôme ? (dossiers lourds ignorés ; arrêt dès qu'une limite est dépassée)"""
    max_files = SHADOW_MAX_FILES if max_files is None else max_files
    max_bytes = SHADOW_MAX_BYTES if max_bytes is None else max_bytes
    n = size = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _HEAVY]
        for f in filenames:
            n += 1
            try:
                size += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
            if n > max_files or size > max_bytes:
                return False
    return True


class Snapshots:
    def __init__(self, root: Path, shadow_dir: Path | None = None):
        self.root = Path(root)
        self.git_dir: Path | None = None
        r = self._git("rev-parse", "--show-toplevel", check=False)
        self.top = Path(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None
        self.shadow = False
        if self.top is None and shadow_dir is not None and self.root.is_dir() and self.root.resolve() != Path.home().resolve() \
                and small_enough(self.root):
            try:
                shadow_dir.mkdir(parents=True, exist_ok=True)
                if not (shadow_dir / "HEAD").exists():
                    self._git("init", "-q", "--bare", str(shadow_dir), check=False)
                    (shadow_dir / "info").mkdir(exist_ok=True)
                    (shadow_dir / "info" / "exclude").write_text("\n".join(SHADOW_IGNORE) + "\n", encoding="utf-8")
                if (shadow_dir / "HEAD").exists():
                    self.git_dir, self.top, self.shadow = shadow_dir, self.root.resolve(), True
            except OSError:
                self.git_dir = None

    @property
    def available(self) -> bool:
        return self.top is not None

    def _git(self, *args: str, env: dict | None = None, check: bool = True, cwd: Path | None = None) -> subprocess.CompletedProcess:
        full_env = {**os.environ, **(env or {}), "GIT_OPTIONAL_LOCKS": "0"}
        if getattr(self, "git_dir", None) is not None:
            full_env.update(GIT_DIR=str(self.git_dir), GIT_WORK_TREE=str(self.top))
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

    def changes(self, base: str, max_bytes: int = 400_000) -> dict:
        """Différences entre l'état `base` et l'état actuel du dossier : fichiers (A/M/D) et diff unifié (borné)."""
        if not self.available:
            return {"available": False, "files": [], "diff": "", "truncated": False}
        cur = self.snapshot()
        if not cur or cur == base:
            return {"available": True, "files": [], "diff": "", "truncated": False}
        try:
            rel = self.root.resolve().relative_to(self.top.resolve()).as_posix()
        except ValueError:
            rel = "."
        spec = ["--", rel] if rel not in ("", ".") else []
        names = self._git("diff", "--no-renames", "--name-status", base, cur, *spec, cwd=self.top).stdout
        files = []
        for line in names.splitlines():
            st, _, name = line.partition("\t")
            if name:
                files.append({"status": st, "path": name[len(rel) + 1:] if rel not in ("", ".") and name.startswith(rel + "/") else name})
        diff = self._git("diff", "--no-renames", "--no-color", base, cur, *spec, cwd=self.top).stdout
        truncated = len(diff) > max_bytes
        return {"available": True, "files": files, "diff": diff[:max_bytes], "truncated": truncated}
