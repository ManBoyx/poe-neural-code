"""Connexions, en 3 blocs partagés par le CLI (/connect) et le desktop (écran Connexions) :

1. agents installés sur cet ordinateur (détection automatique, chemin manuel possible) ;
2. fournisseurs par clé d'API (clé dans le trousseau du système, ou variable d'environnement) ;
3. serveurs locaux compatibles OpenAI (LM Studio, Ollama, URL personnalisée) : détection s'ils tournent, modèles chargés.

Aucune clé n'est jamais renvoyée ni journalisée : seulement sa provenance (trousseau / variable d'environnement).
"""
from __future__ import annotations

import asyncio
import os
from urllib.parse import urlparse

import httpx

from . import credentials
from .cli_agents import detect, get_adapter, locate, search_dirs, shell_path
from .config import load_config, save_config
from .providers import ProviderSpec, all_specs, get_spec, save_custom

LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0")


# ------------------------------------------------------------------------------------------------ bloc 1 : agents
def agents(with_version: bool = False, refresh: bool = False, config=None) -> list[dict]:
    return [d.to_json() for d in detect(with_version, config=config, refresh=refresh)]


def search_summary() -> dict:
    """Où Eclipse a cherché (pour l'aide et /doctor)."""
    dirs, err = shell_path()
    return {"path_dirs": len(os.environ.get("PATH", "").split(os.pathsep)), "shell_dirs": len(dirs), "shell_error": err,
            "total_dirs": len(search_dirs())}


def set_agent_path(aid: str, path: str, config=None) -> tuple[bool, str, dict | None]:
    """Chemin manuel d'un agent (vide : retour à la détection automatique). Refusé s'il n'est pas exécutable."""
    a = get_adapter(aid)
    if a is None:
        return False, f"agent inconnu : {aid}", None
    cfg = config or load_config()
    path = (path or "").strip().strip('"')
    if not path:
        cfg.agent_paths.pop(aid, None)
        save_config(cfg)
        d = locate(a)
        return True, f"{a.label} : chemin manuel retiré, détection automatique", d.to_json()
    d = locate(a, dirs=[], manual=path)
    if d.source != "chemin indiqué à la main":
        return False, d.reason.split(" ; ")[0] or "chemin refusé", None
    cfg.agent_paths[aid] = d.path or path
    save_config(cfg)
    return True, f"{a.label} : {d.path}", d.to_json()


# ------------------------------------------------------------------------------------------------ bloc 2 : clés d'API
def is_local(spec: ProviderSpec) -> bool:
    return (urlparse(spec.base_url).hostname or "") in LOCAL_HOSTS or not spec.key_required


def key_source(spec: ProviderSpec) -> str | None:
    """« variable NOM » | « trousseau » | None. Ne renvoie JAMAIS la clé."""
    if spec.key_env and os.environ.get(spec.key_env):
        return f"variable {spec.key_env}"
    return "trousseau" if credentials.get_key(spec.id) else None


def apis() -> list[dict]:
    out = []
    for s in all_specs():
        if is_local(s):
            continue
        src = key_source(s)
        out.append({"id": f"api:{s.id}", "provider": s.id, "label": s.label, "key_required": s.key_required, "has_key": src is not None,
                    "key_source": src, "key_env": s.key_env, "note": s.verified, "notes": s.notes, "custom": s.custom, "url": s.base_url})
    return out


def forget_key(pid: str) -> tuple[bool, str]:
    spec = get_spec(pid)
    if spec is None:
        return False, f"fournisseur inconnu : {pid}"
    gone = credentials.delete_key(spec.id)
    env = f" La variable {spec.key_env} reste prise en compte tant qu'elle est définie." if spec.key_env and os.environ.get(spec.key_env) else ""
    return gone, (f"Clé de {spec.label} retirée du trousseau." if gone else f"Aucune clé enregistrée pour {spec.label} dans le trousseau.") + env


# ------------------------------------------------------------------------------------------------ bloc 3 : serveurs locaux
def local_specs() -> list[ProviderSpec]:
    return [s for s in all_specs() if is_local(s)]


async def probe(url: str, transport=None, timeout: float = 2.0) -> dict:
    """GET <url>/models d'un serveur compatible OpenAI : actif ?, modèles chargés."""
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout) as c:
            r = await c.get(url.rstrip("/") + "/models")
        if r.status_code != 200:
            return {"running": True, "models": [], "error": f"HTTP {r.status_code}"}
        data = r.json().get("data") or []
        return {"running": True, "models": [m.get("id") for m in data if isinstance(m, dict) and m.get("id")][:50], "error": ""}
    except httpx.ConnectError:
        return {"running": False, "models": [], "error": "serveur arrêté (connexion refusée)"}
    except Exception as e:  # noqa: BLE001
        return {"running": False, "models": [], "error": f"{e.__class__.__name__}"}


async def local_servers(transport=None) -> list[dict]:
    specs = local_specs()
    res = await asyncio.gather(*(probe(s.base_url, transport) for s in specs))
    return [{"id": f"api:{s.id}", "provider": s.id, "label": s.label, "url": s.base_url, "custom": s.custom, "key_required": s.key_required, **r}
            for s, r in zip(specs, res)]


def add_server(name: str, url: str, key_required: bool | None = None) -> tuple[bool, str, ProviderSpec | None]:
    """Ajoute un serveur compatible OpenAI (URL personnalisée). Local : sans clé ; distant : clé demandée à la connexion."""
    url = (url or "").strip().rstrip("/")
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False, "adresse invalide : http://… ou https://… attendu (ex. http://localhost:1234/v1)", None
    local = p.hostname in LOCAL_HOSTS
    if not local and p.scheme != "https":
        return False, "adresse distante en http refusée : la clé circulerait en clair (https:// requis)", None
    name = (name or "").strip() or p.hostname
    pid = "".join(ch for ch in name.lower() if ch.isalnum() or ch in "-_")[:40] or "serveur"
    existing = get_spec(pid)
    if existing is not None and not existing.custom:
        pid = f"{pid}-perso"
    need_key = (not local) if key_required is None else bool(key_required)
    spec = ProviderSpec(pid, name, url, f"{pid.upper().replace('-', '_')}_API_KEY", key_required=need_key, custom=True)
    save_custom(spec)
    return True, f"{name} ajouté ({url})", spec
