"""Cache de travail LOCAL (LRU) des passages rechargés depuis le stockage.

Attention : être en cache ici ne veut PAS dire que le modèle le connaît, et ne réduit pas par lui-même les tokens
facturés. Un passage n'entre dans le contexte du modèle que s'il est renvoyé dans un message (ex. résultat
de l'outil memory_load) ; `in_model_context` le trace honnêtement.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field

from .engine import Memory


@dataclass
class Passage:
    key: str
    text: str
    refs: list[str]
    in_model_context: bool = False


class WorkingCache:
    def __init__(self, max_bytes: int = 200_000):
        self.max_bytes = max_bytes
        self._d: OrderedDict[str, Passage] = OrderedDict()
        self.hits = 0
        self.misses = 0

    def _size(self) -> int:
        return sum(len(p.text.encode()) for p in self._d.values())

    def load(self, mem: Memory, ref: str, before: int = 2, after: int = 2) -> Passage | None:
        key = f"{ref}±{before},{after}"
        if key in self._d:
            self.hits += 1
            self._d.move_to_end(key)
            return self._d[key]
        self.misses += 1
        kind, _, n = ref.partition(":")
        if kind == "archive" and n.isdigit():
            rows = mem.load_passage(int(n), before, after)
            if not rows:
                return None
            text = "\n".join(f"[archive:{r['id']}|{r['role']}] {r['content']}" for r in rows)
            refs = [f"archive:{r['id']}" for r in rows]
        else:
            t = mem.resolve_ref(ref)
            if t is None:
                return None
            text, refs = f"[{ref}] {t}", [ref]
        p = Passage(key, text, refs)
        self._d[key] = p
        while self._size() > self.max_bytes and len(self._d) > 1:
            self._d.popitem(last=False)
        return p

    def stats(self) -> dict:
        return {"entries": len(self._d), "bytes": self._size(), "hits": self.hits, "misses": self.misses,
                "in_model_context": sum(p.in_model_context for p in self._d.values())}

    def clear(self) -> None:
        self._d.clear()
