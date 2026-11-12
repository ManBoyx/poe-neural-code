"""Compactage progressif : segment → département → district. Compacter ≠ supprimer.

Garanties (et limites) :
- Les archives originales ne sont jamais modifiées ni supprimées (triggers SQL).
- Les résumés de département et de district sont RECONSTRUITS depuis les items structurés et les plages d'archive,
  jamais par résumé de résumé : pas de perte cumulative par dégradation successive.
- Chaque résumé liste ses sources (plage d'archive, items, résumés) et `verify_summary` les recontrôle
  (intégrité SHA-256, items cités, chemins de fichiers et identifiants entre apostrophes inversées retrouvés dans les sources).
- Aucune garantie d'absence de perte n'est donnée : le résumé narratif est un extrait ; les décisions, tâches,
  contraintes, erreurs et questions viennent des items. Un narratif produit par un modèle reste à vérifier.
- Les sorties d'outils, fichiers et réponses MCP sont des DONNÉES non fiables : elles ne créent jamais
  de décisions/contraintes/tâches (seulement des erreurs et des fichiers concernés).
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field

from .engine import Memory, estimate_tokens

MARKERS = {
    "goal": r"(?:objectif|goal)", "constraint": r"(?:contrainte|constraint)", "decision": r"(?:d[ée]cision|decision)",
    "task": r"(?:t[âa]che|todo)", "hypothesis": r"(?:hypoth[èe]se|hypothesis)", "question": r"(?:question)",
    "fact": r"(?:fait|fact)",
}
_MARK_RX = {k: re.compile(rf"^\s*(?:[-*]\s*)?{v}\s*:\s*(.+)$", re.I | re.M) for k, v in MARKERS.items()}
_ERR_RX = re.compile(r"(Traceback \(most recent call last\)|\bFAILED\b|\bError\b:|\berror\[|Exception:|command not found)")


def should_compact(window: int, expected_work_tokens: int, reserve_ratio: float, current_context_tokens: int,
                   trigger_ratio: float) -> bool:
    """Seuil dépendant de la fenêtre réelle, du volume de travail attendu et de la place réservée aux réponses/outils."""
    usable = window * (1 - reserve_ratio) - expected_work_tokens
    return usable <= 0 or current_context_tokens >= usable * trigger_ratio


def extract_items(mem: Memory, district_id: int, rows) -> list[int]:
    """Items de secours extraits de marqueurs EXPLICITES dans les messages user/assistant (jamais des sorties d'outils)."""
    created: list[int] = []
    seen_files: set[str] = set()
    for r in rows:
        if r["role"] in ("user", "assistant"):
            for kind, rx in _MARK_RX.items():
                for m in rx.finditer(r["content"]):
                    txt = m.group(1).strip()
                    exists = mem.one("SELECT 1 FROM items WHERE district_id=? AND kind=? AND content=?", (district_id, kind, txt))
                    if txt and not exists:
                        iid, _ = mem.add_item(district_id, kind, txt, sources=[{"archive_id": r["id"], "quote": m.group(0)[:200]}])
                        created.append(iid)
        elif r["role"] == "tool":
            meta = json.loads(r["meta"] or "{}")
            if meta.get("path") and meta["path"] not in seen_files:
                seen_files.add(meta["path"])
                if not mem.one("SELECT 1 FROM items WHERE district_id=? AND kind='file' AND content=?", (district_id, meta["path"])):
                    iid, _ = mem.add_item(district_id, "file", meta["path"], sources=[{"archive_id": r["id"], "file_path": meta["path"]}])
                    created.append(iid)
            if _ERR_RX.search(r["content"]):
                line = next((l for l in r["content"].splitlines() if _ERR_RX.search(l)), r["content"][:160]).strip()[:240]
                if not mem.one("SELECT 1 FROM items WHERE district_id=? AND kind='error' AND content=?", (district_id, line)):
                    iid, _ = mem.add_item(district_id, "error", line, sources=[{"archive_id": r["id"], "quote": line}])
                    created.append(iid)
    return created


def _fmt_item(it, mem: Memory) -> str:
    srcs = mem.item_sources(it["id"])
    refs = ",".join([f"archive:{s['archive_id']}" for s in srcs if s["archive_id"]] + [f"file:{s['file_path']}" for s in srcs if s["file_path"]])
    why = f" — raison : {it['rationale']}" if it["rationale"] else ""
    return f"- (item:{it['id']}) {it['content']}{why}" + (f" [{refs}]" if refs else "")


def _sections(mem: Memory, district_id: int, item_ids: set[int] | None = None) -> tuple[list[str], list[int]]:
    """Corps structuré commun aux trois niveaux, fondé sur les items (statuts conservés : rien d'écrasé)."""
    used: list[int] = []
    out: list[str] = []

    def block(title: str, kinds, statuses=("active",), done=False):
        rows = [r for r in mem.items(district_id, kinds, statuses) if item_ids is None or r["id"] in item_ids]
        if rows:
            out.append(f"{title} :")
            for r in rows:
                out.append(_fmt_item(r, mem))
                used.append(r["id"])

    block("Objectifs", ["goal"])
    block("Contraintes", ["constraint"])
    block("Décisions (avec raisons)", ["decision"])
    block("Faits", ["fact"])
    block("Hypothèses (non établies)", ["hypothesis"])
    block("Tâches restantes", ["task"], ("active",))
    block("Tâches terminées", ["task"], ("done",))
    block("Fichiers concernés", ["file"])
    block("Erreurs importantes", ["error"])
    block("Questions non résolues", ["question"])
    block("Anciennes valeurs remplacées/contredites (historique conservé)", None, ("superseded", "contradicted"))
    cons = [c for c in mem.open_contradictions(district_id)]
    if cons:
        out.append("Contradictions ouvertes :")
        out += [f"- item:{c['item_a']} ⟷ item:{c['item_b']} ({c['note']})" for c in cons]
    return out, used


def _narrative(rows, limit: int = 12) -> list[str]:
    out = []
    for r in rows[:limit]:
        tag = {"user": "U", "assistant": "A", "tool": "T"}.get(r["role"], "?")
        txt = " ".join(r["content"].split())
        out.append(f"{tag}[archive:{r['id']}] {txt[:150]}{'…' if len(txt) > 150 else ''}")
    if len(rows) > limit:
        out.append(f"… ({len(rows) - limit} échanges supplémentaires dans la plage, voir archives)")
    return out


def compact_segment(mem: Memory, conversation_id: int, keep_recent: int = 6, min_messages: int = 8,
                    narrative: str | None = None, method: str = "extractive") -> int | None:
    """Résume les anciens échanges (hors `keep_recent` derniers) et avance `compacted_upto`. None si rien à faire."""
    conv = mem.one("SELECT * FROM conversations WHERE id=?", (conversation_id,))
    rows = mem.archive_rows(conversation_id, conv["compacted_upto"])
    if len(rows) - keep_recent < min_messages:
        return None
    seg = rows[: len(rows) - keep_recent]
    did = conv["district_id"]
    new_ids = extract_items(mem, did, seg)
    # items liés à ce segment : ceux dont une source tombe dans la plage
    lo, hi = seg[0]["id"], seg[-1]["id"]
    in_range = {r["item_id"] for r in mem.q("SELECT item_id FROM item_sources WHERE archive_id BETWEEN ? AND ?", (lo, hi))}
    body, used = _sections(mem, did, in_range) if in_range else ([], [])
    lines = [f"Segment — discussion {conversation_id}, archives {lo}–{hi} ({len(seg)} messages)"] + body
    lines.append("Échanges (extrait) :" if narrative is None else "Narratif :")
    lines += _narrative(seg) if narrative is None else [narrative]
    lines.append(f"Sources : archive:{lo}..{hi}")
    sid = mem.add_summary(did, "segment", "\n".join(lines), conversation_id=conversation_id, from_archive_id=lo,
                          to_archive_id=hi, source_item_ids=used, method=method)
    mem._w("UPDATE conversations SET compacted_upto=? WHERE id=?", (hi, conversation_id))
    return sid


def compact_department(mem: Memory, district_id: int, department: str, method: str = "rebuild") -> int:
    dept_id = mem.department_id(district_id, department)
    ids = {r["id"] for r in mem.q("SELECT id FROM items WHERE district_id=? AND department_id=?", (district_id, dept_id))}
    body, used = _sections(mem, district_id, ids)
    segs = mem.q("SELECT id, from_archive_id, to_archive_id FROM summaries WHERE district_id=? AND level='segment' ORDER BY id", (district_id,))
    lines = [f"Département « {department} » — reconstruit depuis les items et les archives (pas un résumé de résumé)"] + (body or ["(aucun item)"])
    lines.append("Sources : " + (", ".join(f"archive:{s['from_archive_id']}..{s['to_archive_id']}" for s in segs) or "aucune plage compactée"))
    return mem.add_summary(district_id, "department", "\n".join(lines), department_id=dept_id,
                           source_summary_ids=[s["id"] for s in segs], source_item_ids=used, method=method)


def synthesize_district(mem: Memory, district_id: int, method: str = "rebuild") -> int:
    d = mem.one("SELECT * FROM districts WHERE id=?", (district_id,))
    body, used = _sections(mem, district_id, None)
    segs = mem.q("SELECT id, from_archive_id, to_archive_id FROM summaries WHERE district_id=? AND level='segment' ORDER BY id", (district_id,))
    lines = [f"Synthèse du district « {d['name']} »" + (f" ({d['path']})" if d["path"] else "")] + (body or ["(aucun item)"])
    lines.append("Sources : " + (", ".join(f"archive:{s['from_archive_id']}..{s['to_archive_id']}" for s in segs) or "aucune plage compactée"))
    return mem.add_summary(district_id, "district", "\n".join(lines), source_summary_ids=[s["id"] for s in segs],
                           source_item_ids=used, method=method)


@dataclass
class VerifyReport:
    ok: bool
    problems: list[str] = field(default_factory=list)
    checked_archives: int = 0


def verify_summary(mem: Memory, summary_id: int) -> VerifyReport:
    s = mem.one("SELECT * FROM summaries WHERE id=?", (summary_id,))
    if not s:
        return VerifyReport(False, ["résumé introuvable"])
    probs: list[str] = []
    texts: list[str] = []
    n = 0
    ranges: list[tuple[int, int]] = []
    if s["from_archive_id"] is not None:
        ranges.append((s["from_archive_id"], s["to_archive_id"]))
    for sid in json.loads(s["source_summary_ids"]):
        r = mem.one("SELECT from_archive_id, to_archive_id FROM summaries WHERE id=?", (sid,))
        if not r:
            probs.append(f"résumé source summary:{sid} introuvable")
        elif r["from_archive_id"] is not None:
            ranges.append((r["from_archive_id"], r["to_archive_id"]))
    for lo, hi in ranges:
        for a in mem.q("SELECT * FROM archive WHERE id BETWEEN ? AND ?", (lo, hi)):
            n += 1
            texts.append(a["content"])
            if hashlib.sha256(a["content"].encode()).hexdigest() != a["sha256"]:
                probs.append(f"archive:{a['id']} : empreinte SHA-256 incohérente")
    for iid in json.loads(s["source_item_ids"]):
        it = mem.one("SELECT * FROM items WHERE id=?", (iid,))
        if not it:
            probs.append(f"item:{iid} introuvable")
            continue
        texts.append(it["content"] + " " + (it["rationale"] or ""))
        texts += [x["file_path"] or "" for x in mem.item_sources(iid)]
        if f"item:{iid}" not in s["content"]:
            probs.append(f"item:{iid} déclaré source mais absent du texte du résumé")
    corpus = "\n".join(texts)
    for ident in set(re.findall(r"`([^`\n]{2,80})`", s["content"])):
        if ident not in corpus:
            probs.append(f"identifiant `{ident}` du résumé introuvable dans les sources")
    ok = not probs
    mem._w("UPDATE summaries SET verified_ok=?, verified_at=? WHERE id=?", (int(ok), time.time(), summary_id))
    return VerifyReport(ok, probs, n)
