#!/usr/bin/env python3
"""Prépare les fichiers de mise à jour d'une version : latest.json (manifeste lu par l'application) et SHA256SUMS.

    make_manifest.py --version 1.2.0 --repo ManBoyx/eclipse-releases --dir artefacts/ [--changelog CHANGELOG.md]

Pour chaque paquet installable par la mise à jour automatique (AppImage, .deb, .rpm, installateur NSIS, .msi),
le fichier de signature `<paquet>.sig` produit par `tauri build` (clé privée des secrets GitHub) est obligatoire :
sans lui, le script échoue plutôt que de publier un manifeste incomplet. Chaque entrée porte aussi l'empreinte
SHA-256 du paquet, que l'application contrôle avant la signature.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

# (motif du nom de fichier, clés de plateforme Tauri : précise puis générique)
UPDATABLE = [
    (r"\.AppImage$", ["linux-x86_64-appimage", "linux-x86_64"]),
    (r"\.deb$", ["linux-x86_64-deb"]),
    (r"\.rpm$", ["linux-x86_64-rpm"]),
    (r"-setup\.exe$", ["windows-x86_64-nsis", "windows-x86_64"]),
    (r"\.msi$", ["windows-x86_64-msi"]),
]
PUBLISHED = re.compile(r"\.(AppImage|deb|rpm|exe|msi|zip|apk|sig|tar\.gz)$")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def changelog_section(path: Path, version: str) -> str:
    """Section « ## <version> » du CHANGELOG, jusqu'au titre suivant de même niveau."""
    if not path.is_file():
        return ""
    out, inside = [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            if inside:
                break
            inside = re.match(rf"##\s+\[?v?{re.escape(version)}\]?(\s|$)", line) is not None
            continue
        if inside:
            out.append(line)
    return "\n".join(out).strip()


def build(version: str, repo: str, folder: Path, changelog: Path | None, pub_date: str | None = None) -> tuple[dict, str]:
    base = f"https://github.com/{repo}/releases/download/v{version}"
    files = sorted(p for p in folder.iterdir() if p.is_file() and PUBLISHED.search(p.name))
    platforms: dict[str, dict] = {}
    for pattern, keys in UPDATABLE:
        for f in files:
            # Seuls les noms versionnés entrent dans le manifeste ; les copies à nom fixe (liens « dernière version »)
            # ne servent qu'aux téléchargements manuels et figurent seulement dans SHA256SUMS.
            if not re.search(pattern, f.name) or f.name.endswith(".sig") or version not in f.name:
                continue
            sig = f.with_name(f.name + ".sig")
            if not sig.is_file():
                raise SystemExit(f"signature manquante pour {f.name} : publication refusée")
            entry = {"url": f"{base}/{f.name}", "signature": sig.read_text(encoding="utf-8").strip(), "sha256": sha256(f)}
            for k in keys:
                platforms.setdefault(k, entry)
    if not platforms:
        raise SystemExit("aucun paquet de mise à jour trouvé")
    manifest = {
        "version": version,
        "notes": changelog_section(changelog, version) if changelog else "",
        "pub_date": pub_date or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": platforms,
    }
    sums = "".join(f"{sha256(f)}  {f.name}\n" for f in files if not f.name.endswith(".sig"))
    return manifest, sums


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--dir", required=True, type=Path)
    ap.add_argument("--changelog", type=Path)
    a = ap.parse_args(argv)
    version = a.version.removeprefix("v")
    manifest, sums = build(version, a.repo, a.dir, a.changelog)
    (a.dir / "latest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (a.dir / "SHA256SUMS").write_text(sums, encoding="utf-8")
    print(f"latest.json : {', '.join(manifest['platforms'])}")
    print(f"SHA256SUMS : {len(sums.splitlines())} fichiers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
