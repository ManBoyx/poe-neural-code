"""Serveur de test de l'interface : VRAI serveur Eclipse + fournisseur SIMULÉ (aucune requête à une IA réelle).

Usage : python -m tests_e2e.server <dossier-données> <dossier-projet>  -> écrit {"port":…, "token":…} sur stdout.
"""
import asyncio
import json
import os
import socket
import sys

os.environ["PNC_HOME"] = sys.argv[1]

import uvicorn  # noqa: E402

from poe_neural_code.config import Config, save_config  # noqa: E402
from poe_neural_code.provider.base import TextDelta, ThinkingDelta, ToolCall  # noqa: E402
from poe_neural_code.web.server import Hub, build_app  # noqa: E402
from tests.conftest import FakeProvider  # noqa: E402

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
    hub = Hub(provider_factory=lambda: FakeProvider(script))
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
