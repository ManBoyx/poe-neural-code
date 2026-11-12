"""Analyse minimale d'un en-tête YAML « --- clé: valeur --- » (sans dépendance), y compris les blocs `>`, `>-`, `|`, `|-`."""
from __future__ import annotations

import re


def parse(text: str) -> tuple[dict[str, str], str, str]:
    """(champs simples, corps, en-tête brut). Les valeurs imbriquées (listes, mappings) restent dans l'en-tête brut."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if not m:
        return {}, text.strip(), ""
    raw, body = m.group(1), m.group(2)
    fields: dict[str, str] = {}
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        km = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", lines[i])
        i += 1
        if not km:
            continue
        key, val = km.group(1), km.group(2).strip()
        if re.fullmatch(r"[>|][+-]?", val):  # bloc scalaire : lignes suivantes indentées
            folded = val.startswith(">")
            block: list[str] = []
            while i < len(lines) and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            val = (" " if folded else "\n").join(x for x in block if x) if folded else "\n".join(block).strip()
        fields[key] = val.strip("\"'")
    return fields, body.strip(), raw
