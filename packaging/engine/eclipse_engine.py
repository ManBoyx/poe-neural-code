"""Point d'entrée du moteur Eclipse empaqueté (PyInstaller) : identique à la commande `eclipse`.

Le chargeur PyInstaller (Linux) place LD_LIBRARY_PATH sur ses bibliothèques internes. Les programmes lancés par
Eclipse (bash, git, claude, node…) doivent retrouver celles du système : on rétablit l'environnement d'origine
pour chaque sous-processus, sans toucher au moteur lui-même.
"""
import os
import subprocess
import sys


def _child_env(env):
    base = dict(os.environ if env is None else env)
    orig = os.environ.get("LD_LIBRARY_PATH_ORIG")
    if orig is not None:
        base["LD_LIBRARY_PATH"] = orig
    else:
        base.pop("LD_LIBRARY_PATH", None)
    base.pop("LD_LIBRARY_PATH_ORIG", None)
    for k in [k for k in base if k.startswith("_PYI_") or k.startswith("_MEI")]:
        base.pop(k)
    return base


if getattr(sys, "frozen", False) and sys.platform.startswith("linux"):
    _popen_init = subprocess.Popen.__init__

    def _init(self, *args, env=None, **kwargs):
        _popen_init(self, *args, env=_child_env(env), **kwargs)

    subprocess.Popen.__init__ = _init  # asyncio.create_subprocess_* passe aussi par Popen sous Linux

from poe_neural_code.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
