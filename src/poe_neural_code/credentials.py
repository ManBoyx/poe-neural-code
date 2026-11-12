"""Clés d'API des fournisseurs.

Ordre : variable d'environnement (prioritaire) → trousseau du système si la bibliothèque `keyring` est installée → fichier `credentials.json`
en droits 600 dans le dossier de données (NON chiffré : le dire à l'utilisateur). Les clés ne sont jamais journalisées ni affichées.
"""
from __future__ import annotations

import json
import os
import stat
import sys

from .paths import data_dir

SERVICE = "eclipse-poe-neural-code"


def _file():
    return data_dir() / "credentials.json"


def _keyring():
    try:
        import keyring  # type: ignore
        keyring.get_keyring()
        return keyring
    except Exception:  # noqa: BLE001
        return None


def _read() -> dict[str, str]:
    try:
        return json.loads(_file().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def storage_kind() -> str:
    return "trousseau du système" if _keyring() else "fichier credentials.json (droits 600, non chiffré)"


def get_key(provider_id: str, env: str | None = None) -> str | None:
    if env and os.environ.get(env):
        return os.environ[env].strip()
    kr = _keyring()
    if kr:
        try:
            v = kr.get_password(SERVICE, provider_id)
            if v:
                return v
        except Exception:  # noqa: BLE001
            pass
    return _read().get(provider_id) or None


def set_key(provider_id: str, key: str) -> str:
    key = key.strip()
    kr = _keyring()
    if kr:
        try:
            kr.set_password(SERVICE, provider_id, key)
            return "trousseau du système"
        except Exception:  # noqa: BLE001
            pass
    data = _read()
    data[provider_id] = key
    f = _file()
    f.write_text(json.dumps(data), encoding="utf-8")
    if sys.platform != "win32":
        f.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return "fichier credentials.json (droits 600, non chiffré)"


def delete_key(provider_id: str) -> bool:
    ok = False
    kr = _keyring()
    if kr:
        try:
            kr.delete_password(SERVICE, provider_id)
            ok = True
        except Exception:  # noqa: BLE001
            pass
    data = _read()
    if provider_id in data:
        del data[provider_id]
        _file().write_text(json.dumps(data), encoding="utf-8")
        ok = True
    return ok


def mask(key: str | None) -> str:
    if not key:
        return "—"
    return key[:3] + "…" + key[-3:] if len(key) > 10 else "•••"
