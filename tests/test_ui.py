import asyncio

from textual.widgets import Input, Static

from poe_neural_code.budget import Budget
from poe_neural_code.provider.base import TextDelta
from poe_neural_code.ui.app import EclipseApp, HomeScreen, WorkScreen
from poe_neural_code.ui.util import fmt_duration, parse_duration
from tests.conftest import FakeProvider, tc


def text_of(w):
    for attr in ("content", "renderable", "visual"):
        v = getattr(w, attr, None)
        if v is not None:
            return str(v)
    return str(w.render())


def run(coro):
    return asyncio.run(coro)


async def settle(pilot, n=6):
    for _ in range(n):
        await pilot.pause(0.05)


def test_parse_duration():
    assert parse_duration("30m") == 1800 and parse_duration("2h") == 7200 and parse_duration("1d") == 86400
    assert parse_duration("0") == 0 and parse_duration("") == 0 and parse_duration("45s") == 45
    for bad in ("abc", "10", "-5m"):
        try:
            parse_duration(bad)
            assert False
        except ValueError:
            pass
    assert fmt_duration(125) == "2 min 05 s"


def test_home_then_open_project_and_sidebar(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()

    async def go():
        app = EclipseApp(provider=FakeProvider([]))
        async with app.run_test(size=(120, 40)) as pilot:
            assert isinstance(app.screen, HomeScreen)
            inp = app.screen.query_one("#path", Input)
            inp.value = str(proj)
            await inp.action_submit()
            await settle(pilot)
            assert isinstance(app.screen, WorkScreen)
            sb = app.screen.query_one("#sidebar")
            assert not sb.has_class("hidden")
            await pilot.press("ctrl+b")
            assert sb.has_class("hidden")
            await pilot.press("ctrl+b")
            assert not sb.has_class("hidden")
        return True

    assert run(go())


def test_narrow_terminal_hides_sidebar(tmp_path):
    async def go():
        app = EclipseApp(str(tmp_path), provider=FakeProvider([]))
        async with app.run_test(size=(60, 30)) as pilot:
            await settle(pilot)
            assert app.screen.query_one("#sidebar").has_class("hidden")
            await pilot.resize_terminal(140, 40)
            await settle(pilot)
            assert not app.screen.query_one("#sidebar").has_class("hidden")

    run(go())


def test_todo_commands_update_sidebar_without_model_call(tmp_path):
    prov = FakeProvider([])

    async def go():
        app = EclipseApp(str(tmp_path), provider=prov)
        async with app.run_test(size=(120, 40)) as pilot:
            await settle(pilot)
            p = app.screen.query_one("#prompt", Input)
            for cmd in ("/todo add écrire les tests", "/todo add publier", "/todo done 1"):
                p.value = cmd
                await p.action_submit()
                await settle(pilot, 3)
            t = text_of(app.screen.query_one("#todo", Static))
            assert "écrire les tests" in t and "1/2" in t and "☑" in t
        assert prov.calls == []  # aucun appel modèle pour afficher/modifier la todo

    run(go())


def test_define_token_modal_creates_example_budget(tmp_path):
    async def go():
        app = EclipseApp(str(tmp_path), provider=FakeProvider([]))
        async with app.run_test(size=(120, 50)) as pilot:
            await settle(pilot)
            p = app.screen.query_one("#prompt", Input)
            p.value = "/define-token"
            await p.action_submit()
            await settle(pilot)
            scr = app.screen
            assert type(scr).__name__ == "DefineTokenScreen"
            scr.query_one("#amount", Input).value = "600"
            scr.query_one("#period", Input).value = "30m"
            scr.on_button_pressed(type("E", (), {"button": type("B", (), {"id": "apply"})()})())
            await settle(pilot)
            assert isinstance(app.screen, WorkScreen)
            env = app.sv.budget.envelopes()[0]
            assert (env.amount_points, env.period_s, env.scope, env.on_exhaust, env.carry_over) == (600, 1800, ["*"], "pause", False)
            u = text_of(app.screen.query_one("#usage", Static))
            assert "reste 600" in u and "↻" in u and "sans report" in u and "pause des requêtes" in u
            assert "indisponible" in u  # pas de taux saisi → l'estimation n'est pas inventée

    run(go())


def test_define_token_invalid_input_stays_open(tmp_path):
    async def go():
        app = EclipseApp(str(tmp_path), provider=FakeProvider([]))
        async with app.run_test(size=(120, 50)) as pilot:
            await settle(pilot)
            p = app.screen.query_one("#prompt", Input)
            p.value = "/define-token"
            await p.action_submit()
            await settle(pilot)
            scr = app.screen
            scr.query_one("#period", Input).value = "bientôt"
            scr.on_button_pressed(type("E", (), {"button": type("B", (), {"id": "apply"})()})())
            await settle(pilot)
            assert type(app.screen).__name__ == "DefineTokenScreen"
            assert "durée attendue" in text_of(app.screen.query_one("#dt-error", Static))
            assert app.sv.budget.envelopes() == []

    run(go())


def test_chat_turn_with_permission_modal_and_labels(tmp_path):
    prov = FakeProvider([[tc("write_file", {"path": "a.txt", "content": "salut\n"})], [TextDelta("Fait.")]], usage=(1000, 200))

    async def go():
        app = EclipseApp(str(tmp_path), provider=prov)
        async with app.run_test(size=(130, 45)) as pilot:
            await settle(pilot)
            p = app.screen.query_one("#prompt", Input)
            for cmd in ("/model m1", "/rate 30000"):
                p.value = cmd
                await p.action_submit()
                await settle(pilot, 3)
            p.value = "crée a.txt"
            await p.action_submit()
            for _ in range(60):
                await pilot.pause(0.05)
                if type(app.screen).__name__ == "PermissionScreen":
                    break
            assert type(app.screen).__name__ == "PermissionScreen"
            assert not (tmp_path / "a.txt").exists()  # rien d'appliqué avant la décision
            await pilot.press("o")
            for _ in range(60):
                await pilot.pause(0.05)
                if not app.screen.busy if isinstance(app.screen, WorkScreen) else False:
                    break
            await settle(pilot)
            assert (tmp_path / "a.txt").read_text() == "salut\n"
            u = text_of(app.screen.query_one("#usage", Static))
            pts_line = next(l for l in u.splitlines() if l.strip().startswith("Points"))
            assert "[estimé]" in pts_line and "[mesuré]" not in pts_line  # points estimés, jamais « mesurés »
            assert "mesurés" in u  # tokens renvoyés par le fournisseur

    run(go())


def test_escape_interrupts_running_turn(tmp_path):
    prov = FakeProvider([[TextDelta("a"), TextDelta("b"), TextDelta("c"), TextDelta("d")]])
    prov.delay = 0.4

    async def go():
        app = EclipseApp(str(tmp_path), provider=prov)
        async with app.run_test(size=(120, 40)) as pilot:
            await settle(pilot)
            p = app.screen.query_one("#prompt", Input)
            p.value = "/model m1"
            await p.action_submit()
            await settle(pilot, 3)
            p.value = "go"
            await p.action_submit()
            await pilot.pause(0.6)
            assert app.screen.busy
            await pilot.press("escape")
            for _ in range(60):
                await pilot.pause(0.05)
                if not app.screen.busy:
                    break
            assert not app.screen.busy

    run(go())


def test_missing_key_message_on_screen(tmp_path):
    from poe_neural_code.provider.poe import PoeProvider

    async def go():
        app = EclipseApp(str(tmp_path), provider=PoeProvider())
        async with app.run_test(size=(120, 40)) as pilot:
            await settle(pilot)
            assert app.sv.provider.configured() is False

    run(go())


def test_claude_mode_commands_and_panel(tmp_path):
    from poe_neural_code.claude_runner import MODEL_ID

    async def go():
        app = EclipseApp(str(tmp_path), provider=FakeProvider([]))
        async with app.run_test(size=(130, 50)) as pilot:
            await settle(pilot)
            p = app.screen.query_one("#prompt", Input)
            for cmd in ("/mode claude", "/claude-limit 200000 5h", "/model haiku"):
                p.value = cmd
                await p.action_submit()
                await settle(pilot, 4)
            sv = app.sv
            assert sv.mode == "claude" and sv.config.claude_model == "haiku"
            env = [e for e in sv.budget.envelopes() if e.kind == "claude"][0]
            assert (env.token_limit, env.period_s, env.scope, env.on_exhaust) == (200000, 18000, [MODEL_ID], "pause")
            sv.claude.info.rate = {"rateLimitType": "five_hour", "utilization": 0.92, "resetsAt": 4102444800}
            app.screen.refresh_panels()
            u = text_of(app.screen.query_one("#usage", Static))
            assert "Claude Code" in u and "Usage   5 h" in u and "92 %" in u and "█" in u and "[mesuré]" in u and "sans objet" in u
            assert "Taux points/USD" not in u  # pas de bruit « points » en mode Claude
            assert "Tokens" in u and "/ 200 000" in u and "Temps" in u
            p.value = "/mode poe"
            await p.action_submit()
            await settle(pilot, 4)
            assert sv.mode == "poe"

    run(go())
