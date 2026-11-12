"""Outils fichiers : explorer, lire, rechercher, créer, modifier (avec diff), supprimer."""
from __future__ import annotations

import difflib
import fnmatch
import os
import re
from pathlib import Path

from .base import Tool, ToolContext, ToolResult
from .permissions import PermissionRequest

SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build"}
MAX_READ = 60_000
MAX_RESULTS = 200


def _diff(old: str, new: str, name: str) -> str:
    return "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), f"a/{name}", f"b/{name}"))


def _outside_req(tool: str, path: Path, ctx: ToolContext, kind: str) -> PermissionRequest:
    return PermissionRequest(tool, kind, f"{tool} hors du projet : {path}", outside=True, grant_key=f"{tool}:{path}",
                             warnings=["chemin hors du projet autorisé"])


class ListDir(Tool):
    name = "list_dir"
    description = "Liste le contenu d'un dossier du projet (chemin relatif à la racine du projet)."
    schema = {"type": "object", "properties": {"path": {"type": "string"}}, "additionalProperties": False}

    async def prepare(self, args, ctx):
        p, inside = ctx.workspace.resolve(args.get("path", "."))
        return None if inside else _outside_req(self.name, p, ctx, "read")

    async def run(self, args, ctx):
        p, _ = ctx.workspace.resolve(args.get("path", "."))
        if not p.is_dir():
            return ToolResult(False, f"{ctx.workspace.rel(p)} n'est pas un dossier")
        rows = []
        for e in sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))[:MAX_RESULTS]:
            rows.append(f"{'d' if e.is_dir() else 'f'} {e.name}{'/' if e.is_dir() else ''}")
        return ToolResult(True, "\n".join(rows) or "(vide)", {"path": ctx.workspace.rel(p)})


class ReadFile(Tool):
    name = "read_file"
    description = "Lit un fichier texte (option : plage de lignes start/end, 1-indexées)."
    schema = {"type": "object", "properties": {"path": {"type": "string"}, "start": {"type": "integer", "minimum": 1},
                                               "end": {"type": "integer", "minimum": 1}},
              "required": ["path"], "additionalProperties": False}

    async def prepare(self, args, ctx):
        p, inside = ctx.workspace.resolve(args["path"])
        return None if inside else _outside_req(self.name, p, ctx, "read")

    async def run(self, args, ctx):
        p, _ = ctx.workspace.resolve(args["path"])
        if not p.is_file():
            return ToolResult(False, f"fichier introuvable : {args['path']}")
        data = p.read_bytes()
        if b"\0" in data[:4096]:
            return ToolResult(False, "fichier binaire : lecture refusée")
        lines = data.decode("utf-8", errors="replace").splitlines()
        s, e = args.get("start", 1), args.get("end", len(lines))
        txt = "\n".join(f"{i}\t{l}" for i, l in enumerate(lines[s - 1:e], s))
        note = ""
        if len(txt) > MAX_READ:
            txt, note = txt[:MAX_READ], f"\n[… tronqué à {MAX_READ} caractères : utilisez start/end]"
        return ToolResult(True, txt + note, {"path": ctx.workspace.rel(p)})


class SearchFiles(Tool):
    name = "search_files"
    description = "Recherche une expression régulière dans les fichiers du projet (glob optionnel, ex. *.py)."
    schema = {"type": "object", "properties": {"pattern": {"type": "string"}, "glob": {"type": "string"}, "path": {"type": "string"}},
              "required": ["pattern"], "additionalProperties": False}

    async def prepare(self, args, ctx):
        p, inside = ctx.workspace.resolve(args.get("path", "."))
        return None if inside else _outside_req(self.name, p, ctx, "read")

    async def run(self, args, ctx):
        try:
            rx = re.compile(args["pattern"])
        except re.error as e:
            return ToolResult(False, f"expression invalide : {e}")
        root, _ = ctx.workspace.resolve(args.get("path", "."))
        out: list[str] = []
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in SKIP_DIRS]
            for fn in fns:
                if args.get("glob") and not fnmatch.fnmatch(fn, args["glob"]):
                    continue
                fp = Path(dp) / fn
                try:
                    if fp.stat().st_size > 1_000_000:
                        continue
                    for i, line in enumerate(fp.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                        if rx.search(line):
                            out.append(f"{ctx.workspace.rel(fp)}:{i}: {line.strip()[:200]}")
                            if len(out) >= MAX_RESULTS:
                                return ToolResult(True, "\n".join(out) + "\n[… résultats tronqués]")
                except OSError:
                    continue
        return ToolResult(True, "\n".join(out) or "aucun résultat")


class WriteFile(Tool):
    name = "write_file"
    description = "Crée ou remplace un fichier avec le contenu fourni. L'utilisateur voit le diff avant application."
    schema = {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
              "required": ["path", "content"], "additionalProperties": False}

    async def prepare(self, args, ctx):
        p, inside = ctx.workspace.resolve(args["path"])
        old = p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""
        diff = _diff(old, args["content"], ctx.workspace.rel(p)) or "(aucun changement)"
        return PermissionRequest(self.name, "write", f"{'Modifier' if p.exists() else 'Créer'} {ctx.workspace.rel(p)}", diff,
                                 outside=not inside, grant_key="write", warnings=[] if inside else ["hors du projet"])

    async def run(self, args, ctx):
        p, _ = ctx.workspace.resolve(args["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(args["content"], encoding="utf-8")
        return ToolResult(True, f"écrit : {ctx.workspace.rel(p)} ({len(args['content'])} caractères)", {"path": ctx.workspace.rel(p)})


class EditFile(Tool):
    name = "edit_file"
    description = "Remplace UNE occurrence unique de old_string par new_string dans un fichier existant (diff montré avant)."
    schema = {"type": "object", "properties": {"path": {"type": "string"}, "old_string": {"type": "string", "minLength": 1},
                                               "new_string": {"type": "string"}},
              "required": ["path", "old_string", "new_string"], "additionalProperties": False}

    def _compute(self, args, ctx):
        p, inside = ctx.workspace.resolve(args["path"])
        if not p.is_file():
            return p, inside, None, "fichier introuvable"
        old = p.read_text(encoding="utf-8", errors="replace")
        n = old.count(args["old_string"])
        if n != 1:
            return p, inside, None, f"old_string doit apparaître exactement une fois ({n} trouvées)"
        return p, inside, old.replace(args["old_string"], args["new_string"], 1), None

    async def prepare(self, args, ctx):
        p, inside, new, err = self._compute(args, ctx)
        if err:
            return None  # l'erreur sera remontée par run()
        old = p.read_text(encoding="utf-8", errors="replace")
        return PermissionRequest(self.name, "write", f"Modifier {ctx.workspace.rel(p)}", _diff(old, new, ctx.workspace.rel(p)),
                                 outside=not inside, grant_key="write", warnings=[] if inside else ["hors du projet"])

    async def run(self, args, ctx):
        p, inside, new, err = self._compute(args, ctx)
        if err:
            return ToolResult(False, err)
        p.write_text(new, encoding="utf-8")
        return ToolResult(True, f"modifié : {ctx.workspace.rel(p)}", {"path": ctx.workspace.rel(p)})


class DeleteFile(Tool):
    name = "delete_file"
    description = "Supprime un fichier (opération destructrice : confirmation toujours demandée)."
    schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}

    async def prepare(self, args, ctx):
        p, inside = ctx.workspace.resolve(args["path"])
        return PermissionRequest(self.name, "delete", f"SUPPRIMER {ctx.workspace.rel(p)}", destructive=True, outside=not inside,
                                 grant_key="delete", warnings=["destructif"] + ([] if inside else ["hors du projet"]))

    async def run(self, args, ctx):
        p, _ = ctx.workspace.resolve(args["path"])
        if not p.is_file():
            return ToolResult(False, "fichier introuvable (seuls les fichiers peuvent être supprimés)")
        p.unlink()
        return ToolResult(True, f"supprimé : {ctx.workspace.rel(p)}", {"path": ctx.workspace.rel(p)})
