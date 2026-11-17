"""Moteur du desktop (4.0.0) : Connexions en 3 blocs, chemin manuel, commandes « / » du CLI, effort rapide/normal/profond."""
import stat

from poe_neural_code.config import load_config
from poe_neural_code.provider.base import ModelInfo, ParamSpec
from tests.test_web import AUTH, setup, wait  # noqa: F401  (fixture)


def open_project(c, hub, proj):
    c.post("/api/open", headers=AUTH, json={"workspace": str(proj)})
    assert wait(lambda: hub.sv is not None and hub.sv.models)


def test_connections_three_blocks_and_versions(setup):
    c, hub, turns, proj = setup
    r = c.get("/api/connections", headers=AUTH).json()
    assert {"agents", "apis", "locals", "storage", "search"} <= set(r)
    ids = {a["id"] for a in r["agents"]}
    assert {"claude", "cli:opencode", "cli:gemini", "cli:codex", "cli:kiro", "cli:aider", "cli:cline"} <= ids
    assert all(not a["installed"] and a["reason"] for a in r["agents"])  # PATH de test : rien d'installé, jamais caché
    assert {s["provider"] for s in r["locals"]} >= {"lmstudio", "ollama"} and not any(a["provider"] in ("lmstudio", "ollama") for a in r["apis"])
    assert c.get("/api/connections?versions=1&refresh=1", headers=AUTH).status_code == 200
    srv = c.get("/api/local_servers", headers=AUTH).json()["servers"]
    assert {s["provider"] for s in srv} >= {"lmstudio", "ollama"} and all("running" in s for s in srv)


def test_agent_path_endpoint_and_selecting_missing_agent_refused(setup, tmp_path):
    c, hub, turns, proj = setup
    open_project(c, hub, proj)
    r = c.post("/api/connect", headers=AUTH, json={"target": "cli:kiro"}).json()
    assert r["ok"] is False and "introuvable" in r["message"] and hub.sv.mode != "cli:kiro"
    f = tmp_path / "kiro-cli"
    f.write_text("#!/bin/sh\necho kiro 1.0\n")
    f.chmod(f.stat().st_mode | stat.S_IXUSR)
    assert c.post("/api/agent_path", headers=AUTH, json={"agent": "kiro", "path": str(tmp_path / "absent")}).status_code == 400
    r = c.post("/api/agent_path", headers=AUTH, json={"agent": "kiro", "path": str(f)}).json()
    assert r["ok"] and r["agent"]["installed"] and r["agent"]["source"] == "chemin indiqué à la main"
    assert hub.sv.config.agent_paths["kiro"] == str(f) and load_config().agent_paths["kiro"] == str(f)
    r = c.post("/api/connect", headers=AUTH, json={"target": "cli:kiro"}).json()
    assert r["ok"] and str(f) in r["message"] and str(proj) in r["message"] and hub.sv.mode == "cli:kiro"


def test_add_server_and_forget_key_endpoints(setup):
    c, hub, turns, proj = setup
    r = c.post("/api/add_server", headers=AUTH, json={"name": "Local", "url": "http://localhost:9999/v1"}).json()
    assert r["ok"] and r["key_required"] is False
    assert any(s["provider"] == r["id"][4:] for s in c.get("/api/connections", headers=AUTH).json()["locals"])
    assert c.post("/api/add_server", headers=AUTH, json={"name": "x", "url": "http://exemple.com/v1"}).status_code == 400
    assert c.post("/api/forget_key", headers=AUTH, json={"provider": "openai"}).json()["ok"] is False


def test_slash_commands_from_cli_run_in_engine(setup):
    c, hub, turns, proj = setup
    assert c.post("/api/slash", headers=AUTH, json={"name": "doctor"}).status_code == 409  # rien d'ouvert
    open_project(c, hub, proj)
    cat = c.get("/api/slash", headers=AUTH).json()
    assert {"doctor", "context", "detect", "agent-path", "effort", "fusion"} <= {x["name"] for x in cat["commands"]}
    run = lambda n, a="", **k: c.post("/api/slash", headers=AUTH, json={"name": n, "args": a, **k}).json()
    d = run("doctor")
    assert d["title"].startswith("Diagnostic") and "Agent : Kiro CLI" in d["text"] and "non installé" in d["text"]
    assert "Recherche des agents" in d["text"]
    assert "Total estimé" in run("context")["text"]
    assert "Fournisseur" in run("status")["text"]
    assert "[--] Codex CLI" in run("detect")["text"]
    t = run("todo", "add écrire les tests")
    assert "écrire les tests" in t["text"] and hub.sv.ctx.todos.items
    # bypass : confirmation obligatoire, rien ne change avant
    r = run("bypass")
    assert r["need_confirm"] and hub.sv.ctx.permissions.mode != "bypass"
    r = run("bypass", confirmed=True)
    assert r["ok"] and hub.sv.ctx.permissions.mode == "bypass" and r["state"]["permissions"] == "bypass"
    assert run("bypass", "off")["ok"] and hub.sv.ctx.permissions.mode == "ask"
    assert run("limit", "150000 5h")["ok"] and run("limit", "abc")["ok"] is False
    assert run("fusion", "add cli:opencode")["state"] and "cli:opencode" in hub.sv.config.fusion_helpers
    assert run("inconnue")["ok"] is False
    assert run("provider")["open"] == "connections"


def test_effort_levels_and_default_effort(setup):
    c, hub, turns, proj = setup
    open_project(c, hub, proj)
    hub.sv.models["m1"] = ModelInfo("m1", 100_000, 8000, 1e-6, 3e-6, True, params=[ParamSpec("reasoning_effort", "enum", ["low", "medium", "high"], None)])
    s = c.post("/api/effort", headers=AUTH, json={"value": "profond"}).json()
    assert s["effort"]["current"] == "high" and s["effort"]["level"] == "profond" and s["effort"]["levels"]["rapide"] == "low"
    s = c.post("/api/effort", headers=AUTH, json={"value": None}).json()
    assert s["effort"]["current"] is None
    r = c.post("/api/settings", headers=AUTH, json={"default_effort": "rapide"}).json()
    assert r["default_effort"] == "rapide" and hub.sv.config.default_effort == "rapide"
    assert c.get("/api/state", headers=AUTH).json()["default_effort"] == "rapide"
    assert hub.sv.agent.options() == {"reasoning_effort": "low"}  # appliqué sans choix explicite
    r = c.post("/api/slash", headers=AUTH, json={"name": "effort", "args": "par-defaut profond"}).json()
    assert r["ok"] and hub.sv.config.default_effort == "profond"
