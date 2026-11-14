"""/doctor (diagnostic de l'installation) et /context (ce qui occupe le contexte du modèle)."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass

import httpx

from . import __version__
from .cli_agents import detect
from .extensions.prompting import extra_system
from .memory.context import build_context
from .memory.engine import estimate_tokens
from .paths import data_dir
from .providers import all_specs, has_credentials


@dataclass
class Check:
    name: str
    status: str  # ok | warn | fail | info
    detail: str


async def doctor(sv, transport=None) -> list[Check]:
    out: list[Check] = []
    out.append(Check("Eclipse", "info", f"{__version__} · Python {sys.version.split()[0]} · {sys.platform}"))
    out.append(Check("Python ≥ 3.11", "ok" if sys.version_info >= (3, 11) else "fail", sys.version.split()[0]))
    d = data_dir()
    out.append(Check("Dossier de données", "ok" if os.access(d, os.W_OK) else "fail", str(d)))
    try:
        sqlite3.connect(":memory:").execute("create virtual table t using fts5(a)")
        out.append(Check("SQLite FTS5 (recherche mémoire)", "ok", "disponible"))
    except sqlite3.Error:
        out.append(Check("SQLite FTS5 (recherche mémoire)", "fail", "absent : recherche mémoire impossible"))
    out.append(Check("Git (/undo, /diff)", "ok" if shutil.which("git") else "warn", "disponible" if shutil.which("git") else "absent : /undo ne restaurera pas les fichiers"))
    out.append(Check("Projet sous Git", "ok" if sv.snap.available else "warn", str(sv.ctx.workspace.root) if sv.snap.available else "non : /undo n'annulera que la conversation"))
    out.append(Check("Fournisseur actif", "ok" if (sv.is_cli or sv.provider.configured()) else "fail",
                     sv.mode_label + ("" if sv.is_cli or sv.provider.configured() else " — sans clé (/connect)")))
    keys = [s.label for s in all_specs() if s.key_required and has_credentials(s)]
    out.append(Check("Clés d'API enregistrées", "info", ", ".join(keys) or "aucune"))

    async def reach(url: str) -> str:
        try:
            async with httpx.AsyncClient(transport=transport, timeout=6) as c:
                r = await c.get(url)
                return f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            return f"injoignable ({e.__class__.__name__})"

    poe, orr = await asyncio.gather(reach("https://api.poe.com/v1/models"), reach("https://openrouter.ai/api/v1/models"))
    out.append(Check("Réseau : Poe", "ok" if poe.startswith("HTTP 2") else "warn", poe))
    out.append(Check("Réseau : OpenRouter", "ok" if orr.startswith("HTTP 2") else "warn", orr))
    for dct in detect(with_version=False):
        if dct.installed:
            out.append(Check(f"Agent : {dct.adapter.label}", "ok", f"{dct.path} · {dct.adapter.verified}"))
    for m in sv.mcp.status():
        out.append(Check(f"MCP : {m['name']}", "ok" if m["state"] == "connected" else "warn", f"{m['state']} ({m['tools']} outils) {m['error'] or ''}".strip()))
    pending = [p.name for p in sv.ext.plugins.plugins.values() if not p.trusted]
    if pending:
        out.append(Check("Plugins non approuvés", "warn", ", ".join(pending) + " (/plugins trust NOM)"))
    for p in sv.ext.plugins.plugins.values():
        if p.error:
            out.append(Check(f"Plugin {p.name}", "fail", p.error))
    pm = sv.ctx.permissions
    out.append(Check("Permissions", "warn" if pm.mode == "bypass" else "ok", pm.mode + (" (TOTAL)" if pm.bypass_all else "")))
    if not sv.is_cli and sv.mode == "poe" and not sv.config.points_per_usd:
        out.append(Check("Taux points/USD", "warn", "non défini : points « indisponibles » (/rate N)"))
    return out


def context_breakdown(sv) -> dict:
    """Estimation (≈ 4 caractères/token) de ce qui serait envoyé au prochain tour."""
    from .agent import SYSTEM, msg_tokens
    a = sv.agent
    parts: list[tuple[str, int]] = [("Instructions de base d'Eclipse", estimate_tokens(SYSTEM))]
    extra = extra_system(sv.ext, sv.session.agent, sv.ctx.workspace.root, sv.config)
    for block in extra.split("\n## "):
        if block.strip():
            title = block.strip().splitlines()[0].lstrip("# ").split("(")[0].strip()[:50]
            parts.append((title, estimate_tokens(block)))
    usable = int(a.window() * (1 - sv.config.reserve_for_output_ratio))
    pack = build_context(sv.memory, sv.session.district_id, sv.session.conversation_id, token_budget=max(500, int(usable * 0.25)))
    parts.append((f"Mémoire du projet ({len(pack.refs)} réf.)", pack.tokens))
    parts.append(("Todo list", estimate_tokens(json.dumps(sv.ctx.todos.to_json(), ensure_ascii=False))))
    hist = sum(msg_tokens(m) for m in a.messages) if not sv.is_cli else 0
    parts.append((f"Historique ({len(a.messages)} messages)" if not sv.is_cli else "Historique (géré par l'agent externe)", hist))
    specs = a._tool_specs()
    parts.append((f"Définitions d'outils ({len(specs)})", estimate_tokens(json.dumps(specs, ensure_ascii=False))))
    total = sum(n for _, n in parts)
    return {"parts": parts, "total": total, "window": a.window() if not sv.is_cli else None, "usable": usable,
            "reserve_ratio": sv.config.reserve_for_output_ratio}
