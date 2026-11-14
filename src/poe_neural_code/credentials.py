"""Clés d'API des fournisseurs : JAMAIS en clair sur le disque.

Ordre de lecture : variable d'environnement (prioritaire) → trousseau du système.
- Linux : Secret Service (GNOME Keyring, KWallet) via libsecret/D-Bus ;
- Windows : Gestionnaire d'identification (Windows Credential Manager) ;
- macOS : Trousseau.
Sans trousseau sécurisé disponible (serveur sans session graphique, par exemple), l'enregistrement est REFUSÉ avec
une explication : utilisez alors la variable d'environnement du fournisseur. Les clés ne sont jamais journalisées
ni affichées (voir `mask`).

Les anciennes versions pouvaient écrire `credentials.json` en clair : au premier accès avec un trousseau disponible,
son contenu est transféré dans le trousseau puis le fichier est supprimé.
"""
from __future__ import annotations

import json
import os

from .paths import data_dir

SERVICE = "eclipse-poe-neural-code"

# Modules de trousseau qui ne chiffrent pas réellement (fichiers en clair, ou « chiffrés » avec une clé stockée à côté).
_INSECURE_PREFIXES = ("keyring.backends.fail", "keyring.backends.null", "keyrings.alt")


class KeyringUnavailable(RuntimeError):
    """Aucun trousseau sécurisé : on refuse d'écrire la clé plutôt que de la stocker en clair."""


def _legacy_file():
    return data_dir() / "credentials.json"


def _secure(backend) -> bool:
    mod = type(backend).__module__
    if mod.startswith(_INSECURE_PREFIXES):
        return False
    if hasattr(backend, "backends"):  # ChainerBackend : au moins un trousseau réel derrière
        return any(_secure(b) for b in backend.backends)
    try:
        return float(getattr(backend, "priority", 1)) > 0
    except Exception:  # noqa: BLE001
        return True


def _keyring():
    """Le module `keyring` si un trousseau SÉCURISÉ est utilisable, sinon None."""
    try:
        import keyring  # type: ignore
        return keyring if _secure(keyring.get_keyring()) else None
    except Exception:  # noqa: BLE001
        return None


def backend_name() -> str | None:
    kr = _keyring()
    if not kr:
        return None
    try:
        b = kr.get_keyring()
        return getattr(b, "name", None) or type(b).__name__
    except Exception:  # noqa: BLE001
        return "trousseau"


def storage_kind() -> str:
    name = backend_name()
    if name:
        return f"trousseau du système ({name})"
    return "aucun trousseau sécurisé disponible : clés seulement par variables d'environnement"


def _migrate_legacy(kr) -> None:
    f = _legacy_file()
    if not f.is_file():
        return
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        for pid, key in data.items():
            if key and not kr.get_password(SERVICE, pid):
                kr.set_password(SERVICE, pid, key)
        f.unlink()
    except Exception:  # noqa: BLE001
        pass  # on réessaiera au prochain accès ; le fichier n'est de toute façon plus jamais lu sans trousseau


def get_key(provider_id: str, env: str | None = None) -> str | None:
    if env and os.environ.get(env):
        return os.environ[env].strip()
    kr = _keyring()
    if not kr:
        return None
    _migrate_legacy(kr)
    try:
        return kr.get_password(SERVICE, provider_id) or None
    except Exception:  # noqa: BLE001
        return None


def set_key(provider_id: str, key: str, env: str | None = None) -> str:
    """Enregistre la clé dans le trousseau ; lève KeyringUnavailable s'il n'y en a pas (jamais de repli en clair)."""
    kr = _keyring()
    if not kr:
        hint = f" Définissez plutôt la variable d'environnement {env}." if env else ""
        raise KeyringUnavailable(
            "Aucun trousseau sécurisé disponible (Secret Service / KWallet sous Linux, Gestionnaire d'identification "
            "sous Windows) : la clé n'est PAS enregistrée, pour ne jamais l'écrire en clair." + hint)
    _migrate_legacy(kr)
    kr.set_password(SERVICE, provider_id, key.strip())
    return storage_kind()


def delete_key(provider_id: str) -> bool:
    kr = _keyring()
    if not kr:
        return False
    try:
        kr.delete_password(SERVICE, provider_id)
        return True
    except Exception:  # noqa: BLE001
        return False


def mask(key: str | None) -> str:
    if not key:
        return "—"
    return key[:3] + "…" + key[-3:] if len(key) > 10 else "•••"
