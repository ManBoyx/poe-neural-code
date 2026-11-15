"""Journaux lisibles avec masquage des données sensibles."""
from __future__ import annotations

import logging
import logging.handlers
import os
import re

from .paths import data_dir

_PATTERNS = [re.compile(p) for p in (
    r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}", r"(?i)((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+",
    r"\bsk-[A-Za-z0-9_\-]{8,}", r"\bghp_[A-Za-z0-9]{20,}")]
_ENV_KEYS = ("POE_API_KEY",)


def redact(text: str) -> str:
    for k in _ENV_KEYS:
        v = os.environ.get(k)
        if v and len(v) >= 6:
            text = text.replace(v, "***")
    for rx in _PATTERNS:
        text = rx.sub(lambda m: (m.group(1) if m.groups() else "") + "***", text)
    return text


class _Redact(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = ()
        return True


def logs_dir():
    """Dossier des journaux : <données>/logs (moteur pnc.log, interface ui.log, sortie d'erreur engine-stderr.log)."""
    d = data_dir() / "logs"
    d.mkdir(exist_ok=True)
    return d


def get_logger(name: str = "pnc") -> logging.Logger:
    """Journal <données>/logs/<name>.log, avec rotation (1 Mo, 3 anciens fichiers) et masquage des secrets.
    Si le dossier de données change (PNC_HOME, tests), le fichier suit."""
    log = logging.getLogger(name)
    path = str(logs_dir() / f"{name}.log")
    current = [h for h in log.handlers if isinstance(h, logging.handlers.RotatingFileHandler)]
    if current and current[0].baseFilename == path:
        return log
    for h in current:
        log.removeHandler(h)
        h.close()
    log.setLevel(logging.INFO)
    h = logging.handlers.RotatingFileHandler(path, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    h.addFilter(_Redact())
    log.addHandler(h)
    log.propagate = False
    return log
