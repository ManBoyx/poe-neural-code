import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

from poe_neural_code import agent as A
from poe_neural_code.claude_bridge import EclipseBridge
from poe_neural_code.claude_runner import MODEL_ID
from poe_neural_code.config import Config
from poe_neural_code.services import create_services
from tests.conftest import FakeProvider

FAKE = str(Path(__file__).parent / "data" / "fake_claude.py")


def init(tools=None, sid="sess-1"):
    tools = tools if tools is not None else ["mcp__eclipse__write_file", "mcp__eclipse__run_command", "mcp__eclipse__read_file"]
    return {"type": "system", "subtype": "init", "session_id": sid, "model": "claude-haiku-5-5", "tools": tools}


def assistant(text, mid="m1", usage=None):
    return {"type": "assistant", "message": {"id": mid, "content": [{"type": "text", "text": text}],
                                              "usage": usage or {"input_tokens": 3, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 5000, "output_tokens": 20}}}


def result(inp=4, cc=1000, cr=30000, out=107, cost=0.0042, **kw):
    return {"type": "result", "subtype": "success", "is_error": False, "session_id": "sess-1", "total_cost_usd": cost,
            "usage": {"input_tokens": inp, "cache_creation_input_tokens": cc, "cache_read_input_tokens": cr, "output_tokens": out}, **kw}


RATE = {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed_warning", "resetsAt": 1794248400, "rateLimitType": "five_hour",
                                                         "utilization": 0.92, "unifiedWindows": {"five_hour": {"utilization": 0.92, "resetsAt": 1794248400}}}}


def setup(tmp_path, monkeypatch, scenario, cfg=None, asker_answer="once"):
    sc, log = tmp_path / "sc.json", tmp_path / "log.jsonl"
    sc.write_text(json.dumps(scenario))
    monkeypatch.setenv("FAKE_CLAUDE_SCENARIO", str(sc))
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    proj = tmp_path / "proj"
    proj.mkdir(exist_ok=True)
    asked, ev = [], []

    async def asker(req):
        asked.append(req)
        return asker_answer

    sv = create_services(proj, provider=FakeProvider([]), asker=asker, config=cfg or Config())
    sv.session.mode = "claude"
    sv.agent.emit = ev.append
    sv.claude.emit = ev.append
    sv.claude.claude_cmd = [sys.executable, FAKE]
    return sv, ev, asked, proj, log


def run_turn(sv, text="bonjour", close=True):
    async def go():
        try:
            await sv.claude.run_turn(text)
        finally:
            if close:
                await sv.bridge.stop()
    asyncio.run(go())


def entries(log):
    return [json.loads(l) for l in log.read_text().splitlines()]


def test_measured_consumption_and_subscription_window(tmp_path, monkeypatch):
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, [init(), RATE, assistant("Salut !"), result()])
    run_turn(sv)
    r = sv.budget.conn.execute("SELECT * FROM ledger").fetchone()
    assert r["model"] == MODEL_ID and r["tokens_kind"] == "measured"
    assert (r["tokens_in"], r["tokens_out"]) == (1004, 107)  # entrée neuve (hors cache relu) + sortie
    assert r["points_kind"] == "unavailable" and r["points"] is None  # jamais de points inventés pour Claude
    assert r["usd"] == pytest.approx(0.0042) and "cache relu 30000" in r["note"]
    assert sv.claude.info.rate["utilization"] == 0.92 and sv.claude.info.cache_read_tokens == 30000
    assert any(isinstance(e, A.AssistantMessage) and e.text == "Salut !" for e in ev)
    assert [e for e in ev if isinstance(e, A.TurnDone)][0].interrupted is False
    # archivé dans la mémoire Eclipse
    assert [r["role"] for r in sv.memory.archive_rows(sv.session.conversation_id)] == ["user", "assistant"]


def test_command_line_disables_builtin_tools_and_uses_eclipse_bridge(tmp_path, monkeypatch):
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, [init(), assistant("ok"), result()], cfg=Config(claude_model="haiku", max_agent_steps=7))
    sv.ctx.todos.add("tâche existante")
    run_turn(sv, "mon instruction")
    e = entries(log)[0]
    a = e["argv"]
    assert e["stdin"] == "mon instruction"
    assert a[a.index("--tools") + 1] == "" and "--strict-mcp-config" in a  # aucun outil intégré, aucun autre serveur MCP
    assert a[a.index("--permission-prompts") + 1] == "none" and a[a.index("--allowedTools") + 1] == "mcp__eclipse"
    assert a[a.index("--model") + 1] == "haiku" and a[a.index("--max-turns") + 1] == "7"
    sysp = a[a.index("--append-system-prompt") + 1]
    assert "UNTRUSTED DATA" in sysp and "tâche existante" in sysp and str(proj.resolve()) in sysp
    assert "POE_API_KEY" not in json.dumps(e)


def test_commands_go_through_eclipse_preview_and_permission(tmp_path, monkeypatch):
    scen = [init(), {"call_tool": {"name": "run_command", "arguments": {"command": "echo depuis-claude > out.txt"}}},
            assistant("fait"), result()]
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, scen)
    run_turn(sv)
    assert asked and asked[0].kind == "exec" and "echo depuis-claude" in asked[0].detail  # aperçu de la commande avant exécution
    assert (proj / "out.txt").read_text().strip() == "depuis-claude"
    k = [type(e).__name__ for e in ev]
    assert k.index("ToolRequested") < k.index("ToolFinished")  # mêmes événements UI qu'en mode Poe
    assert any(r["role"] == "tool" for r in sv.memory.archive_rows(sv.session.conversation_id))


def test_denied_edit_not_applied_and_diff_shown(tmp_path, monkeypatch):
    scen = [init(), {"call_tool": {"name": "write_file", "arguments": {"path": "x.py", "content": "print(1)\n"}}}, assistant("ok"), result()]
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, scen, asker_answer="deny")
    run_turn(sv)
    assert asked[0].kind == "write" and "+print(1)" in asked[0].detail and not (proj / "x.py").exists()
    assert "refusé" in [x for x in entries(log) if "tool_result" in x][0]["tool_result"]


def test_sudo_and_outside_paths_handled_like_poe_mode(tmp_path, monkeypatch):
    scen = [init(), {"call_tool": {"name": "run_command", "arguments": {"command": "sudo ls"}}},
            {"call_tool": {"name": "read_file", "arguments": {"path": "/etc/hostname"}}}, assistant("ok"), result()]
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, scen, asker_answer="deny")
    run_turn(sv)
    outs = [x["tool_result"] for x in entries(log) if "tool_result" in x]
    assert "administrateur" in outs[0]
    assert asked[0].outside and "refusé" in outs[1]  # lecture hors projet : confirmation demandée


def test_security_guard_kills_turn_if_builtin_tools_exposed(tmp_path, monkeypatch):
    scen = [init(tools=["Bash", "Edit", "mcp__eclipse__read_file"]), {"call_tool": {"name": "run_command", "arguments": {"command": "touch pwned"}}},
            assistant("trop tard"), result()]
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, scen)
    run_turn(sv)
    assert any(isinstance(e, A.StatusEvent) and "SÉCURITÉ" in e.text for e in ev)
    assert not (proj / "pwned").exists() and not any(isinstance(e, A.AssistantMessage) for e in ev)


def test_token_limit_pause_before_turn(tmp_path, monkeypatch):
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, [init(), assistant("x"), result()])
    sv.budget.set_envelope(kind="claude", name="claude", amount_points=None, token_limit=500, scope=[MODEL_ID])
    async def two():
        await sv.claude.run_turn("1")  # 1er tour : 1111 tokens > 500 → dépasse (compté après coup)
        await sv.claude.run_turn("2")
        await sv.bridge.stop()

    asyncio.run(two())
    assert any(isinstance(e, A.Paused) for e in ev)
    assert len(entries(log)) == 1  # le 2e tour n'a jamais lancé Claude


def test_token_limit_stops_turn_midway(tmp_path, monkeypatch):
    big = {"input_tokens": 10, "cache_creation_input_tokens": 900, "output_tokens": 300, "cache_read_input_tokens": 0}
    scen = [init(), assistant("a", "m1", big), assistant("b", "m2", big), {"sleep": 5}, result()]
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, scen)
    sv.budget.set_envelope(kind="claude", name="claude", amount_points=None, token_limit=1500, scope=[MODEL_ID])
    run_turn(sv)
    assert any(isinstance(e, A.Paused) and "Limite de tokens Claude" in e.reason for e in ev)
    r = sv.budget.conn.execute("SELECT * FROM ledger").fetchone()
    assert "partiel" in r["note"] and r["tokens_kind"] == "measured"  # usage déjà reçu, marqué partiel


def test_poe_budget_not_affected_by_claude_limit(tmp_path, monkeypatch):
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, [init(), assistant("x"), result()])
    sv.budget.set_envelope(kind="temporary", amount_points=600, scope=["*"])  # budget Poe partagé
    sv.budget.set_envelope(kind="claude", amount_points=None, token_limit=10_000_000, scope=[MODEL_ID])
    run_turn(sv)
    poe = [e for e in sv.budget.envelopes() if e.kind == "temporary"][0]
    # le « * » du budget Poe voit le registre, mais les tokens Claude n'ont pas de points : 0 pt dépensé
    assert sv.budget.status(poe)["spent_points"] == 0


def test_interrupt_kills_claude_process(tmp_path, monkeypatch):
    scen = [init(), assistant("début"), {"sleep": 20}, result()]
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, scen)

    async def go():
        t = asyncio.create_task(sv.claude.run_turn("x"))
        await asyncio.sleep(1.5)
        sv.claude.interrupt()
        await asyncio.wait_for(t, 10)
        await sv.bridge.stop()

    asyncio.run(go())
    assert [e for e in ev if isinstance(e, A.TurnDone)][0].interrupted
    assert sv.budget.conn.execute("SELECT COUNT(*) n FROM reservations WHERE state='held'").fetchone()["n"] == 0


def test_resume_session_id_persisted_and_reused(tmp_path, monkeypatch):
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, [init(sid="abc-123"), assistant("1"), result()])
    async def two():
        await sv.claude.run_turn("1")
        assert sv.session.claude_session_id == "abc-123"
        await sv.claude.run_turn("2")
        await sv.bridge.stop()

    asyncio.run(two())  # une seule boucle : un asyncio.Event est lié à sa boucle
    a2 = entries(log)[1]["argv"]
    assert a2[a2.index("--resume") + 1] == "abc-123"


def test_claude_missing_binary_is_explicit(tmp_path, monkeypatch):
    sv, ev, asked, proj, log = setup(tmp_path, monkeypatch, [])
    sv.claude.claude_cmd = ["/nonexistent/claude-bin"]
    run_turn(sv)
    assert any(isinstance(e, A.StatusEvent) and "introuvable" in e.text for e in ev)
    assert sv.budget.conn.execute("SELECT COUNT(*) n FROM reservations WHERE state='held'").fetchone()["n"] == 0


def test_bridge_requires_token_and_lists_eclipse_tools(tmp_path):
    sv = create_services(tmp_path, provider=FakeProvider([]), config=Config())

    async def go():
        url = await sv.bridge.start()
        try:
            async with httpx.AsyncClient() as c:
                r = await c.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                assert r.status_code == 401  # sans jeton : refusé
                r = await c.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={"Authorization": "Bearer faux"})
                assert r.status_code == 401
            assert url.startswith("http://127.0.0.1:")
        finally:
            await sv.bridge.stop()

    asyncio.run(go())
