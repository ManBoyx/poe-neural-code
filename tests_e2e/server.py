"""Serveur de test de l'interface : VRAI serveur Eclipse + fournisseur SIMULÉ (aucune requête à une IA réelle).

Usage : python -m tests_e2e.server <dossier-données> <dossier-projet>  -> écrit {"port":…, "token":…} sur stdout.
"""
import asyncio
import json
import os
import socket
import sys

os.environ["PNC_HOME"] = sys.argv[1]
os.environ["ECLIPSE_AGENT_SCAN"] = "path"  # jamais le shell ni les dossiers réels de la machine de test

import uvicorn  # noqa: E402

from poe_neural_code.config import Config, save_config  # noqa: E402
from poe_neural_code.provider.base import TextDelta, ThinkingDelta, ToolCall  # noqa: E402
from poe_neural_code.web.server import Hub, build_app  # noqa: E402
from tests.conftest import MODEL, FakeProvider  # noqa: E402
from poe_neural_code.provider.base import ModelInfo, ParamSpec  # noqa: E402

MODEL_EFFORT = ModelInfo("m-effort", context_length=100_000, max_output=8000, prompt_price=1e-6, completion_price=3e-6, supports_tools=True,
                         params=[ParamSpec("reasoning_effort", "enum", ["low", "medium", "high"], "medium")])
from poe_neural_code import cli_agents, connections  # noqa: E402

# Détection simulée : Claude Code et OpenCode « installés », quel que soit l'ordinateur qui lance les tests (jamais lancés : faux chemins).
_FAKE = {"claude", "opencode"}


def _fake_detect(with_version=False, **_kw):
    return [cli_agents.Detected(a, f"/faux/{a.binary}", "1.0.0" if with_version else "", source="PATH") if a.id in _FAKE
            else cli_agents.Detected(a, None, reason=f"« {a.binary} » introuvable dans 3 dossiers (PATH)") for a in cli_agents.all_adapters()]


connections.detect = _fake_detect
import poe_neural_code.diagnostics as _diag  # noqa: E402
_diag.detect = _fake_detect
cli_agents.find_binary = lambda aid, config=None: f"/faux/{aid}" if aid in _FAKE else None

TOKEN = "jeton-e2e"
ANSWER = ("Voici ce que contient le projet :\n\n- `README.md` : la présentation\n\n"
          "```python\ndef saluer(nom: str) -> str:\n    return f\"Bonjour {nom} !\"\n```\n\nVoulez-vous que je crée les tests ?")


def turns():
    return [[ThinkingDelta("Je regarde les fichiers."), ToolCall("t1", "list_dir", json.dumps({"path": "."}))],
            [ToolCall("t2", "run_command", json.dumps({"command": "ls -la"}))],
            [TextDelta(ANSWER[:30]), TextDelta(ANSWER[30:])]] + [[TextDelta(f"Réponse {i}.")] for i in range(20)]


async def main(project: str):
    save_config(Config(model="m1", discussions_dir=os.path.join(sys.argv[1], "discussions")))
    script = turns()
    class Provider(FakeProvider):  # deux modèles : m1 (sans effort) et m-effort (low/medium/high)
        async def list_models(self):
            return [MODEL, MODEL_EFFORT]

    hub = Hub(provider_factory=lambda: Provider(script))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    app = build_app(TOKEN, [port], hub)
    await hub.open(project)
    sv = hub.sv
    d = sv.session.district_id
    sv.memory.add_item(d, "decision", "Le site utilise Flask plutôt que Django.", key="framework")
    sv.memory.add_item(d, "fact", "Les tests se lancent avec : pytest -q", key="tests")
    root = sv.ctx.workspace.root
    (root / "src").mkdir(exist_ok=True)
    (root / "src" / "app.py").write_text('from flask import Flask\napp = Flask(__name__)\n', encoding="utf-8")
    print(json.dumps({"port": port, "token": TOKEN}), flush=True)
    await uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off")).serve(sockets=[sock])


if __name__ == "__main__":
    asyncio.run(main(sys.argv[2]))
