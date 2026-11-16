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


class ForbiddenCommand(AdminRefused):
    """Commande TOUJOURS refusée (destruction du système ou d'un disque), quel que soit le mode, même bypass total."""


# Cibles dont la suppression récursive détruirait le système ou le dossier personnel.
_ROOT_TARGETS = re.compile(r"""^["']?(/|/\*|~|~/|~/\*|\$HOME|\$\{HOME\}|\$HOME/\*?|\$env:USERPROFILE|%USERPROFILE%|"""
                           r"""/(bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)/?|"""
                           r"""[a-zA-Z]:[\\/]?|[a-zA-Z]:[\\/]\*|[a-zA-Z]:[\\/](Windows|Users|Program Files)[\\/]?)["']?$""", re.I)
# Motifs dangereux où qu'ils soient dans la ligne (redirections, dd vers un périphérique, fork bomb).
_FORBIDDEN_ANYWHERE = [
    (re.compile(r"\bdd\b[^;&|]*\bof=/dev/", re.I), "écriture directe sur un périphérique (dd)"),
    (re.compile(r">\s*/dev/(sd|hd|nvme|vd|mmcblk|disk)", re.I), "écriture directe sur un disque"),
    (re.compile(r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"), "bombe de processus (fork bomb)"),
]
# Programmes refusés quand ils sont LA commande lancée (un simple mot dans un grep ou un echo reste permis).
_FORBIDDEN_PROGRAMS = {
    **{n: "formatage ou partitionnement de disque" for n in (
        "mkfs", "mke2fs", "mkswap", "wipefs", "fdisk", "sfdisk", "gdisk", "parted", "blkdiscard", "diskpart",
        "format-volume", "clear-disk", "initialize-disk", "remove-partition")},
    **{n: "arrêt ou redémarrage de l'ordinateur" for n in ("shutdown", "poweroff", "halt", "reboot", "stop-computer", "restart-computer")},
    "bcdedit": "modification destructrice du système Windows",
}


def _segments(cmd: str) -> list[list[str]]:
    import shlex
    out = []
    for seg in re.split(r"\s*(?:&&|\|\||;|\||\n)\s*", cmd):
        try:
            toks = shlex.split(seg, posix=True)
        except ValueError:
            toks = seg.split()
        if toks:
            out.append(toks)
    return out


def forbidden_reason(cmd: str) -> str | None:
    """Raison du refus définitif, ou None. Complète la confirmation manuelle, ne la remplace pas."""
    for rx, why in _FORBIDDEN_ANYWHERE:
        if rx.search(cmd):
            return why
    for toks in _segments(cmd):
        name = toks[0].lower().rsplit("/", 1)[-1].removesuffix(".exe")
        base = name.split(".", 1)[0]  # mkfs.ext4 -> mkfs
        if name in _FORBIDDEN_PROGRAMS or base in _FORBIDDEN_PROGRAMS:
            return _FORBIDDEN_PROGRAMS.get(name) or _FORBIDDEN_PROGRAMS[base]
        args = " ".join(toks[1:]).lower()
        if name in ("format", "format.com") and re.match(r"^[a-z]:", args):
            return "formatage de disque"
        if (name == "cipher" and "/w" in args) or (name == "vssadmin" and "delete" in args and "shadows" in args) \
                or (name == "reg" and args.startswith("delete") and "hklm" in args):
            return "modification destructrice du système Windows"
        flags = [t for t in toks[1:] if t.startswith("-") or (t.startswith("/") and len(t) <= 3 and name in ("rd", "rmdir", "del", "erase"))]
        targets = [t for t in toks[1:] if t not in flags]
        recursive = any(("r" in f.lower() and f.startswith("-") and not f.startswith("--")) or f.lower() in ("--recursive", "-recurse", "/s")
                        for f in flags) or "--no-preserve-root" in toks
        if name in ("rm", "rmdir", "rd", "del", "erase", "remove-item", "ri") and recursive and any(_ROOT_TARGETS.match(t) for t in targets):
            return "suppression récursive d'un dossier système, d'un disque ou du dossier personnel"
        if name in ("chmod", "chown", "chgrp") and recursive and any(_ROOT_TARGETS.match(t) for t in targets):
            return "changement récursif de droits sur un dossier système ou le dossier personnel"
    return None


def check_command(cmd: str) -> tuple[bool, list[str]]:
    """(destructif?, avertissements). Lève AdminRefused (élévation) ou ForbiddenCommand (liste noire) : aucun mode ne
    permet de passer outre, ni « modifications auto », ni bypass, ni bypass total."""
    if ADMIN.search(cmd):
        raise AdminRefused("Élévation de privilèges (sudo/runas…) refusée : aucun accès administrateur implicite.")
    why = forbidden_reason(cmd)
    if why:
        raise ForbiddenCommand(f"Commande toujours refusée ({why}) : Eclipse ne l'exécute dans aucun mode, même si vous l'autorisez.")
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
