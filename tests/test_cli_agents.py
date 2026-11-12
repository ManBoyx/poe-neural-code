import asyncio
import json
import os
import stat
import sys
from pathlib import Path

import pytest

from poe_neural_code import agent as A
from poe_neural_code import cli_agents as CA
from poe_neural_code.config import Config
from poe_neural_code.delegated_runner import DelegatedRunner
from poe_neural_code.services import create_services
from tests.conftest import FakeProvider

FAKE = str(Path(__file__).parent / "data" / "fake_agent.py")


def test_detection_uses_path_and_lists_all_presets(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name in ("opencode", "gemini"):
        f = bindir / name
        f.write_text("#!/bin/sh\necho v1.2.3\n")
        f.chmod(0o755)
    monkeypatch.setenv("PATH", str(bindir))
    found = {d.adapter.id: d for d in CA.detect(with_version=True)}
    assert found["opencode"].installed and found["opencode"].version == "v1.2.3" and found["gemini"].installed
    assert not found["codex"].installed and not found["kiro"].installed and not found["claude"].installed
    assert {"claude", "opencode", "gemini", "codex", "kiro"} <= set(found)


def test_presets_are_honest_about_verification():
    by = {a.id: a for a in CA.PRESETS}
    assert by["claude"].integrated and "testé en réel" in by["claude"].verified
    assert "testé en réel" in by["opencode"].verified and "--auto" in by["opencode"].notes
    assert "NON testé" in by["gemini"].verified and "NON installé" in by["codex"].verified and "NON vérifiées" in by["kiro"].verified
    assert "--auto" not in by["opencode"].args  # jamais d'approbation automatique des permissions de l'agent


def test_custom_adapters_from_agents_json():
    (CA.data_dir() / "agents.json").write_text(json.dumps([{"id": "mon", "label": "Mon agent", "binary": "mon-agent", "args": ["--x"], "prompt_via": "stdin"}, {"bad": 1}]))
    a = CA.get_adapter("mon")
    assert a.custom and a.prompt_via == "stdin" and a.scope_id == "cli:mon" and CA.get_adapter("bad") is None


def test_build_command_variants():
    op, gm = CA.get_adapter("opencode"), CA.get_adapter("gemini")
    cmd, stdin = CA.build_command(op, "/b/opencode", "fais X", model="p/m#high", plan=True, session_id="ses_1")
    assert cmd == ["/b/opencode", "run", "--format", "json", "--agent", "plan", "--model", "p/m#high", "--session", "ses_1", "fais X"] and stdin is None
    cmd, _ = CA.build_command(gm, "/b/gemini", "salut", plan=True)
    assert cmd == ["/b/gemini", "-o", "text", "--approval-mode", "plan", "-p", "salut"]
    cmd, stdin = CA.build_command(CA.CliAdapter("s", "s", "s", ["x"], "stdin"), "/b/s", "texte")
    assert cmd == ["/b/s", "x"] and stdin == "texte"


def test_parse_opencode_line_real_format_and_tolerance():
    real = '{"type":"text","timestamp":1794275188662,"sessionID":"ses_e3cd","part":{"id":"p","type":"text","text":"ok","time":{"start":1,"end":2}}}'
    assert CA.parse_opencode_line(real) == {"kind": "text", "session": "ses_e3cd", "text": "ok"}
    tk = CA.parse_opencode_line(json.dumps({"type": "step-finish", "sessionID": "s", "part": {"tokens": {"input": 10, "output": 4}}}))
    assert tk["tokens"] == (10, 4) and "text" not in tk
    assert CA.parse_opencode_line("pas du json")["kind"] == "raw"
    assert CA.parse_opencode_line(json.dumps({"type": "inconnu"})) == {"kind": "inconnu", "session": None}  # types inconnus ignorés, jamais devinés


# ------------------------------------------------------------------ lanceur délégué
def make(tmp_path, monkeypatch, scenario, adapter_id="opencode", cfg=None):
    sc, log = tmp_path / "sc.json", tmp_path / "log.jsonl"
    sc.write_text(json.dumps(scenario))
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", str(sc))
    monkeypatch.setenv("FAKE_AGENT_LOG", str(log))
    proj = tmp_path / "proj"
    proj.mkdir(exist_ok=True)
    sv = create_services(proj, provider=FakeProvider([]), config=cfg or Config())
    ev = []
    sv.set_emit(ev.append)
    a = CA.get_adapter(adapter_id)
    patched = CA.CliAdapter(**{**a.__dict__, "binary": sys.executable, "args": [FAKE, *([] if adapter_id != "opencode" else [])], "plan_args": a.plan_args})
    r = DelegatedRunner(sv.config, sv.budget, sv.memory, sv.ctx, sv.session, ev.append, patched, sys.executable)
    sv.delegated[adapter_id] = r
    sv.session.mode = f"cli:{adapter_id}"
    return sv, r, ev, log


def run(sv, text="bonjour", close=True):
    asyncio.run(sv.runner.run_turn(text))


def entries(log):
    return [json.loads(l) for l in log.read_text().splitlines()]


OC_TEXT = {"type": "text", "sessionID": "ses_9", "part": {"type": "text", "text": "Réponse d'OpenCode"}}


def test_delegated_turn_estimates_tokens_and_warns_about_tools(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [OC_TEXT])
    run(sv, "Bonjour")
    assert any(isinstance(e, A.AssistantMessage) and e.text == "Réponse d'OpenCode" for e in ev)
    row = sv.budget.conn.execute("SELECT * FROM ledger").fetchone()
    assert row["model"] == "cli:opencode" and row["tokens_kind"] == "estimated" and row["points_kind"] == "unavailable"  # jamais « mesuré » sans compteur
    assert "ESTIMÉS" in row["note"] and row["tokens_out"] > 0 and row["tokens_in"] > 0
    warn = [e.text for e in ev if isinstance(e, A.StatusEvent) and "délégué" in e.text]
    assert warn and "ne peut pas en prévisualiser" in warn[0]  # transparence : pas d'aperçu des commandes de l'agent
    assert sv.session.cli_sessions["opencode"] == "ses_9"  # session de l'agent mémorisée
    assert [x["role"] for x in sv.memory.archive_rows(sv.session.conversation_id)] == ["user", "assistant"]


def test_no_memory_block_when_memory_is_empty(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [OC_TEXT])
    run(sv, "juste ça")
    assert entries(log)[0]["argv"][-1] == "juste ça"  # aucune mémoire : le message n'est pas pollué


def test_delegated_second_turn_resumes_session_and_skips_context(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [OC_TEXT])
    sv.memory.add_item(sv.session.district_id, "decision", "On utilise pytest")

    async def two():
        await r.run_turn("un")
        await r.run_turn("deux")

    asyncio.run(two())
    a1, a2 = entries(log)[0]["argv"], entries(log)[1]["argv"]
    assert a1[-1].startswith("un") and "On utilise pytest" in a1[-1] and "--session" not in a1  # 1er tour : demande d'abord, contexte d'Eclipse ensuite
    assert "non fiable" not in a1[-1]  # pas d'en-tête de prompt système dans le message utilisateur
    assert a2[a2.index("--session") + 1] == "ses_9" and a2[-1] == "deux"  # reprise : l'agent a déjà le contexte


def test_measured_tokens_when_agent_provides_counter(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [OC_TEXT, {"type": "step-finish", "part": {"tokens": {"input": 321, "output": 45}}}])
    run(sv)
    row = sv.budget.conn.execute("SELECT * FROM ledger").fetchone()
    assert (row["tokens_in"], row["tokens_out"], row["tokens_kind"]) == (321, 45, "measured")


def test_text_agent_gemini_style_plan_args_and_model(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [{"raw": "Bonjour"}, {"raw": "monde"}], adapter_id="gemini", cfg=Config(cli_models={"gemini": "g-pro"}))
    r.adapter.plan_args = ["--approval-mode", "plan"]
    sv.session.agent = "plan"
    run(sv, "salut")
    a = entries(log)[0]["argv"]
    assert "--approval-mode" in a and a[a.index("-m") + 1] == "g-pro" and a[a.index("-p") + 1].endswith("salut")
    assert any(isinstance(e, A.AssistantMessage) and e.text == "Bonjour\nmonde" for e in ev)
    sv.session.agent = "build"


def test_plan_mode_warns_if_agent_has_no_readonly_option(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [{"raw": "x"}], adapter_id="kiro")
    r.adapter.plan_args = []
    sv.session.agent = "plan"
    run(sv)
    assert any(isinstance(e, A.StatusEvent) and "lecture seule connue" in e.text for e in ev)


def test_token_limit_blocks_before_and_kills_during(tmp_path, monkeypatch):
    big = {"raw": "x" * 4000}
    sv, r, ev, log = make(tmp_path, monkeypatch, [big, {"sleep": 6}, {"raw": "fin"}])
    sv.budget.set_envelope(kind="claude", name="lim", amount_points=None, token_limit=700, scope=["cli:opencode"])
    import time
    t0 = time.time()
    run(sv, "go")
    assert any(isinstance(e, A.Paused) and "Limite de tokens atteinte" in e.reason for e in ev) and time.time() - t0 < 5  # tué avant la fin
    ev.clear()
    run(sv, "encore")  # budget dépassé : pas relancé
    assert any(isinstance(e, A.Paused) for e in ev) and len(entries(log)) == 1


def test_interrupt_kills_process(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [{"raw": "début"}, {"sleep": 30}])

    async def go():
        t = asyncio.create_task(r.run_turn("x"))
        await asyncio.sleep(1.5)
        r.interrupt()
        await asyncio.wait_for(t, 10)

    asyncio.run(go())
    assert [e for e in ev if isinstance(e, A.TurnDone)][0].interrupted
    assert sv.budget.conn.execute("SELECT COUNT(*) n FROM reservations WHERE state='held'").fetchone()["n"] == 0


def test_failure_and_missing_binary_reported(tmp_path, monkeypatch):
    sv, r, ev, log = make(tmp_path, monkeypatch, [{"exit": 3, "stderr": "échec d'authentification"}])
    run(sv)
    assert any(isinstance(e, A.StatusEvent) and "code 3" in e.text and "authentification" in e.text for e in ev)
    r.binary = None
    ev.clear()
    run(sv)
    assert any("introuvable" in e.text for e in ev if isinstance(e, A.StatusEvent))
    assert sv.budget.conn.execute("SELECT COUNT(*) n FROM reservations WHERE state='held'").fetchone()["n"] == 0


def test_services_routes_cli_modes_and_scopes(tmp_path, monkeypatch):
    proj = tmp_path / "p"
    proj.mkdir()
    sv = create_services(proj, provider=FakeProvider([]), config=Config())
    sv.set_mode("cli:opencode")
    assert sv.is_cli and sv.mode_label == "OpenCode" and sv.model_key == "cli:opencode" and sv.model_params() == []
    assert isinstance(sv.runner, DelegatedRunner)
    with pytest.raises(KeyError):
        sv.set_mode("cli:inexistant")
    sv.set_mode("claude")
    assert sv.runner is sv.claude and sv.model_key == "claude-code"
    sv.set_mode("poe")
    assert not sv.is_cli and sv.runner is sv.agent
