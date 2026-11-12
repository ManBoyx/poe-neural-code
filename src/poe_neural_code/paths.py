"""Emplacements des données (Linux : XDG ; Windows : %APPDATA%). Surcharge : PNC_HOME."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    if os.environ.get("PNC_HOME"):
        base = Path(os.environ["PNC_HOME"])
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "poe-neural-code"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "poe-neural-code"
    base.mkdir(parents=True, exist_ok=True)
    return base


def sessions_dir() -> Path:
    p = data_dir() / "sessions"
    p.mkdir(exist_ok=True)
    return p
