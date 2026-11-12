"""Autorisations : lecture dans le projet libre ; tout le reste demande l'accord de l'utilisateur.

Le texte d'un fichier, d'une sortie de commande, d'une archive mémoire ou d'une réponse MCP n'est qu'une DONNÉE :
il ne peut jamais modifier ces règles. Seule une décision de l'utilisateur (via `ask`) change une permission.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable

DESTRUCTIVE = re.compile(
    r"(\brm\b|\brmdir\b|\bdel\b|\brd\b|\bmkfs|\bdd\s+if=|\bformat\b|git\s+reset\s+--hard|git\s+clean|git\s+push\s+.*--force|"
    r"git\s+push\s+-f\b|\bchmod\s+-R|\bchown\s+-R|\bshutdown\b|\breboot\b|\btruncate\b|>\s*/dev/|Remove-Item|\bmv\b.*\s/\s*$)", re.I)
ADMIN = re.compile(r"(^|[;&|]\s*|\s)(sudo|doas|su|runas|pkexec)\b", re.I)


@dataclass
class PermissionRequest:
    tool: str
    kind: str  # read | write | delete | exec | outside | mcp
    summary: str
    detail: str = ""  # diff ou commande complète
    destructive: bool = False
    outside: bool = False
    grant_key: str = ""  # clé pour « autoriser pour la session »
    warnings: list[str] = field(default_factory=list)


Decision = str  # "once" | "session" | "deny"
Asker = Callable[[PermissionRequest], Awaitable[Decision]]


class AdminRefused(Exception):
    pass


def check_command(cmd: str) -> tuple[bool, list[str]]:
    """(destructif?, avertissements). Lève AdminRefused pour toute élévation de privilèges."""
    if ADMIN.search(cmd):
        raise AdminRefused("Élévation de privilèges (sudo/runas…) refusée : aucun accès administrateur implicite.")
    warns = []
    d = bool(DESTRUCTIVE.search(cmd))
    if d:
        warns.append("commande potentiellement destructrice")
    return d, warns


MODES = ("ask", "edits", "bypass")


class PermissionManager:
    """Modes : `ask` (tout demander), `edits` (modifications de fichiers du projet acceptées d'office), `bypass` (plus aucune confirmation).

    Planchers du bypass : l'élévation de privilèges (sudo…) reste refusée (voir check_command) ; les actions DESTRUCTRICES ou HORS du projet redemandent
    toujours confirmation, sauf `bypass_all` (choix explicite et distinct). Le mode n'est JAMAIS restauré d'une session à l'autre : on repart en `ask`.
    """

    def __init__(self, asker: Asker | None = None, auto_accept_edits: bool = False):
        self.asker = asker
        self.mode = "edits" if auto_accept_edits else "ask"
        self.bypass_all = False
        self.session_grants: set[str] = set()
        self.log: list[tuple[str, str, str]] = []  # (outil, résumé, décision)

    @property
    def auto_accept_edits(self) -> bool:
        return self.mode == "edits"

    @auto_accept_edits.setter
    def auto_accept_edits(self, v: bool) -> None:
        self.mode = "edits" if v else ("bypass" if self.mode == "bypass" else "ask")

    def set_mode(self, mode: str, bypass_all: bool = False) -> None:
        if mode not in MODES:
            raise ValueError(f"mode ∈ {MODES}")
        self.mode = mode
        self.bypass_all = bool(bypass_all and mode == "bypass")

    async def authorize(self, req: PermissionRequest) -> bool:
        if req.kind == "read" and not req.outside:
            return True
        if self.mode == "bypass" and (self.bypass_all or not (req.destructive or req.outside)):
            self.log.append((req.tool, req.summary, "bypass"))
            return True
        # Hors projet et destructif : jamais couverts par une autorisation de session.
        sticky = not (req.outside or req.destructive)
        if sticky and req.grant_key in self.session_grants:
            self.log.append((req.tool, req.summary, "session"))
            return True
        if req.kind == "write" and self.auto_accept_edits and not req.outside:
            self.log.append((req.tool, req.summary, "auto-edit"))
            return True
        if self.asker is None:
            self.log.append((req.tool, req.summary, "refusé (aucun demandeur)"))
            return False
        decision = await self.asker(req)
        self.log.append((req.tool, req.summary, decision))
        if decision == "session" and sticky and req.grant_key:
            self.session_grants.add(req.grant_key)
        return decision in ("once", "session")
