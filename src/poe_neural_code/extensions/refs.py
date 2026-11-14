"""Références `@fichier` (contenu ajouté au message) et recherche floue de fichiers pour l'autocomplétion."""
from __future__ import annotations

import os
import re
from pathlib import Path

from ..tools.fs_tools import SKIP_DIRS

REF_RX = re.compile(r"(?<![\w@])@([\w./\\-]+)")
MAX_FILE = 40_000
IMAGE_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
MAX_IMAGE = 5_000_000


def list_files(root: Path, limit: int = 4000) -> list[str]:
    out: list[str] = []
    for dp, dns, fns in os.walk(root):
        dns[:] = sorted(d for d in dns if d not in SKIP_DIRS and not d.startswith(".git"))
        for fn in sorted(fns):
            out.append(str((Path(dp) / fn).relative_to(root)))
            if len(out) >= limit:
                return out
    return out


def fuzzy(files: list[str], query: str, limit: int = 8) -> list[str]:
    q = query.lower()
    scored = []
    for f in files:
        fl = f.lower()
        if not q:
            scored.append((len(f), f))
            continue
        if q in fl:
            scored.append((fl.index(q) + len(f) * 0.01, f))
            continue
        it = iter(fl)
        if all(c in it for c in q):  # sous-séquence
            scored.append((100 + len(f) * 0.01, f))
    return [f for _, f in sorted(scored)[:limit]]


def expand_refs(text: str, root: Path) -> tuple[str, list[str]]:
    """Ajoute le contenu des fichiers cités (@chemin) situés DANS le projet. Retourne (prompt étendu, fichiers inclus)."""
    root = root.resolve()
    included: list[str] = []
    blocks: list[str] = []
    for m in REF_RX.finditer(text):
        rel = m.group(1).rstrip(".")
        p = (root / rel).resolve()
        if rel in included or not (p == root or root in p.parents) or not p.is_file():
            continue
        try:
            data = p.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:4096] or p.suffix.lower() in IMAGE_EXT:
            continue  # binaire / image : géré par find_images
        body = data.decode("utf-8", errors="replace")
        if len(body) > MAX_FILE:
            body = body[:MAX_FILE] + "\n[… tronqué]"
        included.append(rel)
        blocks.append(f"--- Fichier @{rel} ---\n{body}\n--- fin ---")
    return (text + "\n\n" + "\n\n".join(blocks) if blocks else text), included


def find_images(text: str, root: Path) -> list[Path]:
    """Images citées avec @chemin (png, jpg, webp, gif) DANS le projet, ≤ 5 Mo."""
    root = root.resolve()
    out: list[Path] = []
    for m in REF_RX.finditer(text):
        p = (root / m.group(1).rstrip(".")).resolve()
        if p.suffix.lower() in IMAGE_EXT and (root in p.parents) and p.is_file() and p.stat().st_size <= MAX_IMAGE and p not in out:
            out.append(p)
    return out


def image_part(p: Path) -> dict:
    import base64
    return {"type": "image_url", "image_url": {"url": f"data:{IMAGE_EXT[p.suffix.lower()]};base64,{base64.b64encode(p.read_bytes()).decode()}"}}
