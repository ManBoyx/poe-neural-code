import asyncio
import json
import sys
from pathlib import Path

import pytest

from poe_neural_code import cli_agents as CA
from poe_neural_code.config import Config
from poe_neural_code.delegated_runner import DelegatedRunner
from poe_neural_code.provider.base import ModelInfo, ParamSpec, TextDelta
from poe_neural_code.services import create_services
from poe_neural_code.tools.base import TodoList, ToolContext
from poe_neural_code.tools.exec_tool import RunCommand
from poe_neural_code.tools.fs_tools import DeleteFile, ReadFile, WriteFile
from poe_neural_code.tools.permissions import AdminRefused, PermissionManager, PermissionRequest
from poe_neural_code.tools.workspace import Workspace
from tests.conftest import FakeProvider, tc
from tests.test_ui_opencode import P, say, text_of, until
from tests.test_ui_connect import run_app


def req(kind="exec", destructive=False, outside=False, key="k"):
    return PermissionRequest("t", kind, "x", destructive=destructive, outside=outside, grant_key=key)


def run(c):
    return asyncio.run(c)


def test_default_is_ask_and_edits_mode_is_backward_compatible():
    asked = []

    async def asker(r):
        asked.append(r)
        return "once"

    pm = PermissionManager(asker)
    assert pm.mode == "ask" and not pm.auto_accept_edits
    run(pm.authorize(req("write")))
    assert len(asked) == 1
    pm.auto_accept_edits = True
    assert pm.mode == "edits"
    run(pm.authorize(req("write")))
    assert len(asked) == 1  # modification acceptée d'office
    run(pm.authorize(req("exec")))
    assert len(asked) == 2  # mais pas les commandes


def test_bypass_skips_confirmations_but_keeps_floors():
    asked = []

    async def asker(r):
        asked.append(r.kind)
        return "deny"

    pm = PermissionManager(asker)
    pm.set_mode("bypass")
    for kind in ("exec", "write", "mcp", "skill", "plugin", "fusion"):
        assert run(pm.authorize(req(kind)))
    assert asked == []  # aucune confirmation
    # planchers : destructif et hors projet redemandent
    assert not run(pm.authorize(req("exec", destructive=True)))
    assert not run(pm.authorize(req("write", outside=True)))
    assert asked == ["exec", "write"]
    pm.set_mode("bypass", bypass_all=True)  # bypass TOTAL : choix distinct et explicite
    assert run(pm.authorize(req("exec", destructive=True))) and run(pm.authorize(req("write", outside=True)))
    pm.set_mode("ask")
    assert not pm.bypass_all and not run(pm.authorize(req("exec")))  # retour à ask : tout redemandé
    with pytest.raises(ValueError):
        pm.set_mode("n'importe quoi")


def test_bypass_never_lifts_admin_refusal_and_bypass_all_resets(tmp_path):
    pm = PermissionManager(None)
    pm.set_mode("bypass", bypass_all=True)
    ctx = ToolContext(Workspace(tmp_path), Config(), pm, TodoList(), asyncio.Event())
    with pytest.raises(AdminRefused):
        run(RunCommand().prepare({"command": "sudo rm -rf /"}, ctx))  # sudo refusé même en bypass total
    pm.set_mode("edits")
    assert not pm.bypass_all


def test_tools_run_without_prompt_in_bypass_mode(tmp_path):
    proj = tmp_path / "p"
    proj.mkdir()
    sv = create_services(proj, provider=FakeProvider([[tc("write_file", {"path": "a.py", "content": "1"}), tc("run_command", {"command": "echo ok > b.txt"}, "c2"),
                                                       tc("delete_file", {"path": "a.py"}, "c3")], [TextDelta("fait")]]), config=Config())
    sv.session.model = "m1"
    asked = []

    async def asker(r):
        asked.append(r.kind)
        return "once"

    sv.ctx.permissions.asker = asker
    sv.ctx.permissions.set_mode("bypass")
    sv.agent.emit = lambda e: None
    run(sv.agent.run_turn("go"))
    assert (proj / "b.txt").exists()
    assert asked == ["delete"]  # écriture et commande sans confirmation ; la SUPPRESSION (destructive) reste confirmée


def test_permission_mode_not_restored_on_resume(tmp_path):
    proj = tmp_path / "p"
    proj.mkdir()
    sv = create_services(proj, provider=FakeProvider([]), config=Config())
    sv.ctx.permissions.set_mode("bypass", bypass_all=True)
    sv.session.save()
    sv2 = create_services(proj, resume=sv.session.id, provider=FakeProvider([]), config=Config())
    assert sv2.ctx.permissions.mode == "ask"  # le bypass ne survit jamais à un redémarrage


# ------------------------------------------------------------------ agents externes
def test_bypass_args_only_in_bypass_and_never_in_plan():
    op, gm = CA.get_adapter("opencode"), CA.get_adapter("gemini")
    assert op.bypass_args == ["--auto"] and gm.bypass_args == ["--approval-mode", "yolo"]
    assert "--auto" not in CA.build_command(op, "/b/o", "x")[0]
    assert "--auto" in CA.build_command(op, "/b/o", "x", bypass=True)[0]
    assert "--auto" not in CA.build_command(op, "/b/o", "x", bypass=True, plan=True)[0]  # lecture seule prime
    assert CA.get_adapter("codex").bypass_args == []  # pas d'option inventée


def test_delegated_runner_passes_bypass_and_warns(tmp_path, monkeypatch):
    from tests.test_cli_agents import FAKE, OC_TEXT, entries
    from poe_neural_code import agent as A
    sc, log = tmp_path / "sc.json", tmp_path / "log.jsonl"
    sc.write_text(json.dumps([OC_TEXT]))
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", str(sc))
    monkeypatch.setenv("FAKE_AGENT_LOG", str(log))
    proj = tmp_path / "proj"
    proj.mkdir()
    sv = create_services(proj, provider=FakeProvider([]), config=Config())
    ev = []
    sv.set_emit(ev.append)
    a = CA.get_adapter("opencode")
    patched = CA.CliAdapter(**{**a.__dict__, "binary": sys.executable, "args": [FAKE]})
    r = DelegatedRunner(sv.config, sv.budget, sv.memory, sv.ctx, sv.session, ev.append, patched, sys.executable)
    sv.ctx.permissions.set_mode("bypass")
    run(r.run_turn("go"))
    assert "--auto" in entries(log)[0]["argv"]
    assert any(isinstance(e, A.StatusEvent) and "BYPASS" in e.text and "--auto" in e.text for e in ev)


# ------------------------------------------------------------------ interface
def test_bypass_command_requires_confirmation_and_shows_badge(tmp_path):
    async def body(app, pilot, prov):
        pm = app.sv.ctx.permissions
        await say(pilot, app, "/bypass")
        assert await until(pilot, lambda: type(app.screen).__name__ == "ConfirmScreen")
        assert "BYPASS" in app.screen.t and "sudo reste refusé" in app.screen.w and "redemandent confirmation" in app.screen.w
        await pilot.press("n")  # refus : rien ne change
        assert await until(pilot, lambda: type(app.screen).__name__ == "WorkScreen")
        assert pm.mode == "ask"
        await say(pilot, app, "/bypass")
        assert await until(pilot, lambda: type(app.screen).__name__ == "ConfirmScreen")
        await pilot.press("o")
        assert await until(pilot, lambda: pm.mode == "bypass")
        assert "⚠ BYPASS" in text_of(app.screen.query_one("#modeline", __import__("textual.widgets", fromlist=["Static"]).Static)) and not pm.bypass_all
        await say(pilot, app, "/bypass all")
        assert await until(pilot, lambda: type(app.screen).__name__ == "ConfirmScreen") and "TOTAL" in app.screen.t
        await pilot.press("o")
        assert await until(pilot, lambda: pm.bypass_all)
        await say(pilot, app, "/bypass off")
        assert pm.mode == "ask" and not pm.bypass_all
        await say(pilot, app, "/permissions edits")
        assert pm.mode == "edits"
        await say(pilot, app, "/permissions ask")
        assert pm.mode == "ask"

    run_app(tmp_path, body)


def test_turn_in_bypass_mode_shows_no_permission_screen(tmp_path):
    prov = P([[tc("run_command", {"command": "echo salut > f.txt"})], [TextDelta("ok")]])

    async def go():
        from poe_neural_code.ui.app import EclipseApp
        app = EclipseApp(str(tmp_path), provider=prov)
        async with app.run_test(size=(140, 44)) as pilot:
            await pilot.pause(0.4)
            await say(pilot, app, "/model m1")
            app.sv.ctx.permissions.set_mode("bypass")
            await say(pilot, app, "écris")
            assert await until(pilot, lambda: (tmp_path / "f.txt").exists())
            assert not any(type(s).__name__ == "PermissionScreen" for s in app.screen_stack)

    asyncio.run(go())


def test_leader_p_opens_permissions_picker(tmp_path):
    async def body(app, pilot, prov):
        await pilot.press("ctrl+x")
        await pilot.press("p")
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
        assert app.screen.title_text == "Permissions" and len(app.screen.items) == 4
        await pilot.press("escape")

    run_app(tmp_path, body)


def test_effort_command_picker_and_direct_levels(tmp_path):
    M = ModelInfo("m1", 100_000, 8000, 1e-6, 3e-6, True, params=[ParamSpec("reasoning_effort", "enum", ["low", "medium", "high"], "medium")])

    class Q(P):
        async def list_models(self):
            return [M]

    async def go():
        from poe_neural_code.ui.app import EclipseApp
        app = EclipseApp(str(tmp_path), provider=Q([]))
        async with app.run_test(size=(140, 44)) as pilot:
            await pilot.pause(0.4)
            await say(pilot, app, "/effort")  # modèle sans choix : message clair, pas de plantage
            await say(pilot, app, "/model m1")
            await say(pilot, app, "/effort high")
            assert app.sv.current_options() == {"reasoning_effort": "high"}
            await say(pilot, app, "/variant low")  # alias historique
            assert app.sv.current_options()["reasoning_effort"] == "low"
            await say(pilot, app, "/effort énorme")  # valeur hors catalogue : refusée
            assert app.sv.current_options()["reasoning_effort"] == "low"
            await say(pilot, app, "/effort")
            assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
            assert [v for _, v, _ in app.screen.items] == ["__default__", "low", "medium", "high"] and app.screen.current == "low"
            app.screen.query_one("#picker-filter").value = "medium"
            await pilot.pause(0.2)
            await pilot.press("enter")
            assert await until(pilot, lambda: app.sv.current_options().get("reasoning_effort") == "medium")
            await say(pilot, app, "/effort défaut")
            assert "reasoning_effort" not in app.sv.current_options()
            await say(pilot, app, "/provider claude")
            await say(pilot, app, "/effort max")  # Claude Code : low…max
            assert app.sv.current_options() == {"effort": "max"}

    asyncio.run(go())
