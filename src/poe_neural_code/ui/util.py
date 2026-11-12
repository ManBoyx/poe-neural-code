from __future__ import annotations

import re

_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "j": 86400}


def parse_duration(text: str) -> int:
    """'30m' → 1800 ; '2h', '1d', '45s' ; '0'/''/'aucun' → 0 (pas de renouvellement). Lève ValueError sinon."""
    t = text.strip().lower()
    if t in ("", "0", "aucun", "none", "non"):
        return 0
    m = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*([smhdj])", t)
    if not m:
        raise ValueError("durée attendue : 30m, 2h, 1d, 45s (ou 0)")
    return int(float(m.group(1).replace(",", ".")) * _UNITS[m.group(2)])


def fmt_duration(sec: float) -> str:
    sec = max(0, int(sec))
    if sec >= 86400:
        return f"{sec // 86400} j {sec % 86400 // 3600} h"
    if sec >= 3600:
        return f"{sec // 3600} h {sec % 3600 // 60:02d} min"
    if sec >= 60:
        return f"{sec // 60} min {sec % 60:02d} s"
    return f"{sec} s"
