import asyncio
import json
import shutil
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from poe_neural_code import cg
from poe_neural_code import cli_agents
from poe_neural_code.web import slash


@pytest.mark.parametrize("lead,planner", [("claude", "claude"), ("codex", "codex"), (None, "claude")])
def test_discussion_transmits_proposals_assignments_and_reports(tmp_path, lead, planner):
    agents = {"claude": "fake-claude", "codex": "fake-codex"}
    discussion = cg.Discussion(tmp_path, agents, lead)
    plan = {"first": "codex", "claude": {"task": "Relire le patch", "write": False},
            "codex": {"task": "Modifier le fichier", "write": True}}

    async def answer(agent, phase, prompt, *, write=False):
        return json.dumps(plan) if phase == "répartition" else f"{agent} {phase}"

    discussion.ask = AsyncMock(side_effect=answer)
    asyncio.run(discussion.turn("Corrige le fichier"))
    calls = discussion.ask.await_args_list
    assert {a.args[0] for a in calls if a.args[1] == "proposition"} == set(agents)
    assert all("Corrige le fichier" in a.args[2] for a in calls if a.args[1] == "proposition")
    allocation = next(a for a in calls if a.args[1] == "répartition")
    assert allocation.args[0] == planner
    assert "claude proposition" in allocation.args[2] and "codex proposition" in allocation.args[2]
    assert ("concertation" in allocation.args[2]) == (lead is None)
    build, read = (a for a in calls if a.args[1] == "exécution")
    assert build.args[0] == "codex" and build.kwargs["write"] is True
    assert read.args[0] == "claude" and read.kwargs["write"] is False
    assert "codex exécution" in read.args[2]
    assert calls[-1].args[0] == planner and "vérification" in calls[-1].args[2]
    assert "Corrige le fichier" in discussion.history[0]


def test_invalid_allocation_never_starts_execution(tmp_path):
    discussion = cg.Discussion(tmp_path, {a: a for a in cg.NAMES}, "codex")
    discussion.ask = AsyncMock(return_value='{"first": "claude", "claude": {"task": "change", "write": "yes"}}')
    with pytest.raises(RuntimeError, match="répartition est invalide"):
        asyncio.run(discussion.turn("Un changement"))
    assert all(a.args[1] != "exécution" for a in discussion.ask.await_args_list)


def test_denied_write_keeps_execution_in_read_only_mode(tmp_path):
    approve = AsyncMock(return_value=False)
    discussion = cg.Discussion(tmp_path, {a: a for a in cg.NAMES}, "codex", approve=approve)
    plan = {"first": "codex", "claude": {"task": "Relire", "write": False},
            "codex": {"task": "Modifier", "write": True}}

    async def answer(agent, phase, prompt, *, write=False):
        return json.dumps(plan) if phase == "répartition" else "Rapport"

    discussion.ask = AsyncMock(side_effect=answer)
    asyncio.run(discussion.turn("Corrige le projet"))
    approve.assert_awaited_once_with("Codex", "Modifier")
    assert all(not c.kwargs.get("write", False) for c in discussion.ask.await_args_list)


def test_desktop_slash_opens_separate_eclipse_session(tmp_path):
    hub = SimpleNamespace(
        sv=SimpleNamespace(ctx=SimpleNamespace(workspace=SimpleNamespace(root=tmp_path))),
        open=AsyncMock(),
    )
    result = asyncio.run(slash.run(hub, "cg", ""))
    assert result == {"ok": True, "state": True}
    hub.open.assert_awaited_once_with(str(tmp_path), cg=True)


def test_textual_slash_switches_to_new_discussion(tmp_path):
    from poe_neural_code.ui.app import EclipseApp
    from poe_neural_code.ui.modals import PickerScreen
    from tests.conftest import FakeProvider
    from tests.test_ui_opencode import say, until

    async def scenario():
        app = EclipseApp(str(tmp_path), provider=FakeProvider([]))
        async with app.run_test(size=(125, 40)) as pilot:
            await pilot.pause()
            previous = app.sv.session.id
            await say(pilot, app, "/cg")
            assert await until(pilot, lambda: isinstance(app.screen, PickerScreen))
            assert [item[1] for item in app.screen.items] == ["claude", "codex", "both"]
            await pilot.press("enter")
            assert await until(pilot, lambda: app.sv.mode == "cg")
            assert app.sv.session.cg_lead == "claude"
            assert app.sv.session.id != previous
            assert app.sv.ctx.workspace.root == tmp_path

    asyncio.run(scenario())


def test_cg_discussion_has_own_saved_session_and_transcript(tmp_path, monkeypatch):
    import httpx

    from poe_neural_code.web.server import Hub, build_app
    from tests.conftest import FakeProvider

    async def fake_sdk(workspace, args, prompt="", **options):
        assert workspace == tmp_path
        if args == ["check"]:
            return "OK"
        agent, binary, access, output = args
        assert binary == agent and access == "read"
        assert "Analyse le projet" in prompt
        if output == "plan":
            assert agent == "claude"
            return json.dumps({"first": "claude", "claude": {"task": "Analyser", "write": False},
                               "codex": {"task": "Vérifier", "write": False}})
        return f"Rapport de {cg.NAMES[agent]}"

    monkeypatch.setattr(cli_agents, "find_binary", lambda name, config: name)
    monkeypatch.setattr(cg, "sdk_call", fake_sdk)

    async def scenario():
        hub = Hub(provider_factory=lambda: FakeProvider([]))
        app = build_app("test-token", [0], hub)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1",
                                     headers={"Authorization": "Bearer test-token"}) as client:
            original = (await client.post("/api/open", json={"workspace": str(tmp_path)})).json()["session"]["id"]
            opened = (await client.post("/api/slash", json={"name": "cg"})).json()["state"]
            new_id = opened["session"]["id"]
            assert original != new_id
            assert opened["session"]["workspace"] == str(tmp_path)
            assert opened["mode"] == "cg" and not opened["configured"]
            assert (await client.post("/api/prompt", json={"text": "Trop tôt"})).status_code == 400
            assert (await client.post("/api/cg/lead", json={"lead": "both"})).json()["configured"]
            assert (await client.post("/api/prompt", json={"text": "Analyse le projet"})).json()["ok"]
            await hub.turn
            await client.post("/api/open", json={"resume": original})
            reopened = (await client.post("/api/open", json={"resume": new_id})).json()
            assert reopened["cg_lead"] == "both"
            items = (await client.get("/api/transcript")).json()["items"]
            assert items[0] == {"kind": "user", "text": "Analyse le projet"}
            assert {item["author"] for item in items if item.get("phase") == "proposition"} == {"Claude Code", "Codex"}
            assert {"kind": "assistant", "author": "Codex", "phase": "vérification", "text": "Rapport de Codex"} in items
            assert items[-1] == {"kind": "assistant", "author": "Claude Code", "phase": "bilan", "text": "Rapport de Claude Code"}
            await hub.sv.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("install_status", [0, 1])
def test_prepare_sdk_installs_once_and_reuses_validated_cache(tmp_path, monkeypatch, install_status):
    source = tmp_path / "source"
    source.mkdir()
    bridge = source / "run.mjs"
    bridge.write_text("// bridge fixture")
    (source / "package.json").write_text('{"private": true}')
    data = tmp_path / "data"
    monkeypatch.setattr(cg, "SDK_BRIDGE", bridge)
    monkeypatch.setattr(cg, "data_dir", lambda: data)
    monkeypatch.setattr(cg, "agent_env", lambda: {"PATH": "/fake/bin"})
    monkeypatch.setattr(cg.shutil, "which", lambda *_args, **_kwargs: "/fake/bin/npm")
    progress = []
    workspace = tmp_path / "project"

    async def check(project, args, *, bridge=None, **kwargs):
        assert project == workspace and args == ["check"]
        if bridge is None:
            raise cg.MissingSdk("package absent")
        assert bridge.read_text() == "// bridge fixture"
        return "OK"

    async def install(command, cwd, env, prompt, timeout):
        assert (cwd / "package.json").read_bytes() == (source / "package.json").read_bytes()
        assert cwd.parent == data / "cg-sdk" and cwd != workspace
        assert command[1] == "install" and "--ignore-scripts" in command
        return install_status, "", "npm error code EAI_AGAIN" if install_status else ""

    monkeypatch.setattr(cg, "sdk_call", check)
    runner = AsyncMock(side_effect=install)
    monkeypatch.setattr(cg, "_run", runner)

    if install_status:
        with pytest.raises(RuntimeError, match="Installation des SDK /cg impossible"):
            asyncio.run(cg.prepare_sdk(workspace, progress.append))
        assert not list((data / "cg-sdk").iterdir())
    else:
        installed = asyncio.run(cg.prepare_sdk(workspace, progress.append))
        assert installed.parent.parent == data / "cg-sdk"
        assert asyncio.run(cg.prepare_sdk(workspace, progress.append)) == installed
        assert [p.name for p in (data / "cg-sdk").iterdir()] == [installed.parent.name]

    runner.assert_awaited_once()
    assert progress == ["Installation des SDK Claude Code et Codex"]


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js non installé")
def test_node_bridge_checks_and_calls_both_sdks(tmp_path, monkeypatch):
    bridge = tmp_path / "run.mjs"
    shutil.copyfile(cg.SDK_BRIDGE, bridge)
    monkeypatch.setattr(cg, "SDK_BRIDGE", bridge)
    monkeypatch.setenv("ECLIPSE_AGENT_SCAN", "path")

    async def call(*args, prompt=""):
        return await cg.sdk_call(tmp_path, list(args), prompt, timeout=5)

    with pytest.raises(RuntimeError, match="SDK Codex indisponible"):
        asyncio.run(call("check"))

    codes = {
        "@openai/codex-sdk": '''
        export class Codex {
          constructor(config) {
            if (config.codexPathOverride !== 'codex-binary') throw Error('Binaire Codex inattendu');
          }
          startThread(options) {
            if (options.sandboxMode !== 'read-only' || options.approvalPolicy !== 'never') throw Error('Permissions Codex inattendues');
            return { run: async (prompt, opts) => ({ finalResponse: JSON.stringify({ prompt, required: opts.outputSchema.required }) }) };
          }
        }
        ''',
        "@anthropic-ai/claude-agent-sdk": '''
        export async function* query({prompt, options}) {
          if (options.pathToClaudeCodeExecutable !== 'claude-binary' || options.permissionMode !== 'acceptEdits') throw Error('Paramètres Claude inattendus');
          if (!options.tools.includes('Write') || options.tools.includes('Bash')) throw Error('Outils Claude inattendus');
          yield { type: 'result', subtype: 'success', is_error: false, structured_output: { prompt, required: options.outputFormat.schema.required } };
        }
        ''',
    }
    for package, code in codes.items():
        directory = tmp_path / "node_modules" / package
        directory.mkdir(parents=True)
        (directory / "package.json").write_text('{"type":"module","exports":"./index.js"}')
        (directory / "index.js").write_text(code)

    assert asyncio.run(call("check")) == "OK"
    expected = {"prompt": "Répartis cette tâche", "required": ["first", "claude", "codex"]}
    assert json.loads(asyncio.run(call("codex", "codex-binary", "read", "plan", prompt=expected["prompt"]))) == expected
    assert json.loads(asyncio.run(call("claude", "claude-binary", "write", "plan", prompt=expected["prompt"]))) == expected
