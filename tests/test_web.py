"""Serveur d'Eclipse Desktop : sécurité (jeton, hôte, CORS), conversation, autorisations, fil, consommation."""
import json
import time

import pytest
from starlette.testclient import TestClient

from poe_neural_code.config import Config, save_config
from poe_neural_code.provider.base import TextDelta, ToolCall
from poe_neural_code.web.server import Hub, build_app
from tests.conftest import FakeProvider

TOKEN = "jeton-de-test"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def wait(cond, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def setup(tmp_path):
    save_config(Config(model="m1"))
    (tmp_path / "proj").mkdir()
    turns: list = []
    hub = Hub(provider_factory=lambda: FakeProvider(turns))
    app = build_app(TOKEN, [0], hub)
    with TestClient(app) as client:
        yield client, hub, turns, tmp_path / "proj"


def test_token_is_required_everywhere(setup):
    c, *_ = setup
    assert c.get("/api/info").status_code == 401
    assert c.get("/api/info", headers={"Authorization": "Bearer faux"}).status_code == 401
    assert c.get("/api/events?token=faux").status_code == 401
    assert c.get("/api/info", headers=AUTH).status_code == 200


def test_host_header_and_cors():
    app = build_app(TOKEN, [4567], Hub())
    with TestClient(app, base_url="http://127.0.0.1:4567") as c:
        assert c.get("/api/info", headers=AUTH).status_code == 200
        assert c.get("/api/info", headers={**AUTH, "Host": "evil.example:4567"}).status_code == 421  # DNS rebinding
        r = c.options("/api/info", headers={"Origin": "tauri://localhost", "Access-Control-Request-Method": "GET"})
        assert r.status_code == 204 and r.headers["access-control-allow-origin"] == "tauri://localhost"
        assert c.options("/api/info", headers={"Origin": "https://site-quelconque.example"}).status_code == 403
        r = c.get("/api/info", headers={**AUTH, "Origin": "https://site-quelconque.example"})
        assert "access-control-allow-origin" not in r.headers


def test_conversation_turn_with_permission_and_transcript(setup):
    c, hub, turns, proj = setup
    events: list = []
    turns += [[ToolCall("t1", "write_file", json.dumps({"path": "note.txt", "content": "bonjour"}))], [TextDelta("Fichier créé.")]]
    r = c.post("/api/open", headers=AUTH, json={"workspace": str(proj)})
    assert r.status_code == 200 and r.json()["open"] and r.json()["model"] == "m1"
    import asyncio
    q: asyncio.Queue = asyncio.Queue()
    hub.subs.add(q)

    assert c.post("/api/prompt", headers=AUTH, json={"text": "écris une note"}).json()["ok"]
    assert wait(lambda: hub.pending)  # demande d'autorisation affichée en carte
    pid, (_, payload) = next(iter(hub.pending.items()))
    assert payload["request"]["tool"] == "write_file" and "bonjour" in payload["request"]["detail"]
    assert c.get("/api/state", headers=AUTH).json()["pending_permissions"][0]["id"] == pid  # renvoyée après rechargement
    assert c.post("/api/permission", headers=AUTH, json={"id": pid, "decision": "once"}).json()["ok"]
    assert wait(lambda: not hub.busy)
    while not q.empty():
        events.append(q.get_nowait())
    kinds = [e["type"] for e in events]
    assert "tool_start" in kinds and "tool_end" in kinds and "idle" in kinds
    assert (proj / "note.txt").read_text() == "bonjour"

    items = c.get("/api/transcript", headers=AUTH).json()["items"]
    assert items[0] == {"kind": "user", "text": "écris une note"}
    tool = next(i for i in items if i["kind"] == "tool")
    assert tool["name"] == "write_file" and tool["args"]["path"] == "note.txt"
    assert "<tool_output" not in (tool["output"] or "")
    assert items[-1]["kind"] == "assistant" and "Fichier créé" in items[-1]["text"]

    u = c.get("/api/usage", headers=AUTH).json()
    assert u["totals"]["requests"] == 2 and u["session_tokens"]["in"] > 0 and not u["subscription"]

    info = c.get("/api/info", headers=AUTH).json()
    assert info["current"] == hub.sv.session.id and info["sessions"][0]["title"] == "écris une note"


def test_denied_permission_writes_nothing_and_interrupt(setup):
    c, hub, turns, proj = setup
    turns += [[ToolCall("t1", "write_file", json.dumps({"path": "x.txt", "content": "non"}))], [TextDelta("d'accord")]]
    c.post("/api/open", headers=AUTH, json={"workspace": str(proj)})
    c.post("/api/prompt", headers=AUTH, json={"text": "écris"})
    assert wait(lambda: hub.pending)
    pid = next(iter(hub.pending))
    assert c.post("/api/permission", headers=AUTH, json={"id": pid, "decision": "n'importe quoi"}).status_code == 400
    c.post("/api/permission", headers=AUTH, json={"id": pid, "decision": "deny"})
    assert wait(lambda: not hub.busy)
    assert not (proj / "x.txt").exists()
    assert c.post("/api/prompt", headers=AUTH, json={"text": "  "}).status_code == 400


def test_model_effort_agent_and_errors(setup):
    c, hub, turns, proj = setup
    assert c.post("/api/prompt", headers=AUTH, json={"text": "x"}).status_code == 409  # rien d'ouvert
    c.post("/api/open", headers=AUTH, json={"workspace": str(proj)})
    assert wait(lambda: hub.sv.models)
    assert c.post("/api/model", headers=AUTH, json={"model": "inconnu"}).status_code == 400
    assert c.post("/api/model", headers=AUTH, json={"model": "m1"}).json()["model"] == "m1"
    assert c.post("/api/agent", headers=AUTH, json={"name": "plan"}).json()["session"]["agent"] == "plan"
    assert c.post("/api/effort", headers=AUTH, json={"value": "high"}).status_code == 400  # m1 n'a pas d'effort
    r = c.post("/api/open", headers=AUTH, json={"workspace": str(proj / "absent")})
    assert r.status_code == 400 and "introuvable" in r.json()["error"]
    conns = c.get("/api/connections", headers=AUTH).json()
    assert any(a["id"] == "api:openai" for a in conns["apis"]) and "trousseau" in conns["storage"]
    r = c.post("/api/connect", headers=AUTH, json={"target": "api:openai"})
    assert r.json() == {"ok": False, "need_key": True, "storage": conns["storage"]}


def test_events_stream_requires_token_and_streams(setup):
    c, hub, *_ = setup
    with c.stream("GET", f"/api/events?token={TOKEN}") as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        first = next(r.iter_lines())
        assert first == "event: hello"
