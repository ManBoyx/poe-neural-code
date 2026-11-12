"""Tests de l'interface refaite : aperçu des commandes, @fichiers, !shell, leader Ctrl+X, modes, effort, thèmes, extensions."""
import asyncio
import subprocess

from textual.widgets import Input, OptionList, Static

from poe_neural_code.provider.base import ModelInfo, ParamSpec, TextDelta, ThinkingDelta
from poe_neural_code.ui.app import EclipseApp, WorkScreen
from poe_neural_code.ui.widgets import ThinkingBlock, ToolBlock, UserBubble
from tests.conftest import FakeProvider, tc

EFFORT_MODEL = ModelInfo("m1", 100_000, 8000, 1e-6, 3e-6, True,
                         params=[ParamSpec("reasoning_effort", "enum", ["low", "medium", "high"], "medium"), ParamSpec("web_search", "boolean", [], True)])


class P(FakeProvider):
    async def list_models(self):
        return [EFFORT_MODEL]


def text_of(w):
    for attr in ("content", "renderable", "visual"):
        v = getattr(w, attr, None)
        if v is not None:
            return str(v)
    return str(w.render())


async def until(pilot, cond, n=80):
    for _ in range(n):
        await pilot.pause(0.05)
        if cond():
            return True
    return False


async def say(pilot, app, text):
    p = app.screen.query_one("#prompt", Input)
    p.value = text
    await p.action_submit()
    await pilot.pause(0.25)


def run_app(tmp_path, turns, body, size=(140, 44), **kw):
    prov = P(turns, **kw)

    async def go():
        app = EclipseApp(str(tmp_path), provider=prov)
        async with app.run_test(size=size) as pilot:
            await pilot.pause(0.4)
            await body(app, pilot, prov)

    asyncio.run(go())


def test_command_preview_while_typing_and_tab_completion(tmp_path):
    async def body(app, pilot, prov):
        p = app.screen.query_one("#prompt", Input)
        prev = app.screen.query_one("#preview", OptionList)
        p.value = "/"
        await pilot.pause(0.2)
        assert prev.has_class("show") and prev.option_count >= 8  # « / » liste les commandes
        p.value = "/und"
        await pilot.pause(0.2)
        assert prev.option_count >= 1 and "undo" in str(prev.get_option_at_index(0).prompt)
        await pilot.press("tab")  # Tab complète au lieu de changer de mode
        await pilot.pause(0.2)
        assert p.value == "/undo " and app.sv.session.agent == "build"
        p.value = "/summ"  # alias OpenCode
        await pilot.pause(0.2)
        assert "compact" in str(prev.get_option_at_index(0).prompt)
        p.value = "bonjour"
        await pilot.pause(0.2)
        assert not prev.has_class("show")

    run_app(tmp_path, [], body)


def test_enter_on_partial_command_runs_highlighted_command(tmp_path):
    async def body(app, pilot, prov):
        p = app.screen.query_one("#prompt", Input)
        p.value = "/sidebar"
        await pilot.pause(0.2)
        before = app.screen.show_sidebar
        await pilot.press("enter")
        await pilot.pause(0.4)
        assert app.screen.show_sidebar != before

    run_app(tmp_path, [], body)


def test_at_file_preview_and_completion_then_submit(tmp_path):
    (tmp_path / "notes.md").write_text("CONTENU_NOTES")

    async def body(app, pilot, prov):
        await say(pilot, app, "/model m1")
        p = app.screen.query_one("#prompt", Input)
        p.value = "lis @not"
        await pilot.pause(0.3)
        prev = app.screen.query_one("#preview", OptionList)
        assert prev.has_class("show") and "notes.md" in str(prev.get_option_at_index(0).prompt)
        await pilot.press("enter")  # complète le jeton, n'envoie pas
        await pilot.pause(0.2)
        assert p.value == "lis @notes.md " and not app.screen.busy
        await pilot.press("enter")  # complet : envoie
        assert await until(pilot, lambda: bool(prov.calls))
        assert "CONTENU_NOTES" in str(prov.calls[0]["messages"])

    run_app(tmp_path, [[TextDelta("ok")]], body)


def test_shell_bang_preview_confirmation_and_context(tmp_path):
    async def body(app, pilot, prov):
        p = app.screen.query_one("#prompt", Input)
        p.value = "!echo bonjour-shell"
        await pilot.pause(0.2)
        prev = app.screen.query_one("#preview", OptionList)
        assert prev.has_class("show") and "confirmation" in str(prev.get_option_at_index(0).prompt)  # aperçu avant exécution
        await pilot.press("enter")
        assert await until(pilot, lambda: type(app.screen).__name__ == "PermissionScreen")
        scr = app.screen
        assert scr.req.kind == "exec" and "echo bonjour-shell" in scr.req.detail
        await pilot.press("o")
        assert await until(pilot, lambda: any("bonjour-shell" in b.output for b in app.screen.query(ToolBlock)))
        assert any("bonjour-shell" in str(m.get("content")) for m in app.sv.agent.messages)  # ajouté à la conversation
        assert app.sv.claude.pending_context  # et préfixé au prochain tour Claude

    run_app(tmp_path, [], body)


def test_tab_switches_mode_and_plan_is_visible_in_modeline(tmp_path):
    async def body(app, pilot, prov):
        assert "BUILD" in text_of(app.screen.query_one("#modeline", Static))
        await pilot.press("tab")
        await pilot.pause(0.2)
        assert app.sv.session.agent == "plan" and "PLAN" in text_of(app.screen.query_one("#modeline", Static))
        await pilot.press("shift+tab")
        await pilot.pause(0.2)
        assert app.sv.session.agent == "build"
        await say(pilot, app, "/mode plan")
        assert app.sv.session.agent == "plan"

    run_app(tmp_path, [], body)


def test_ctrl_t_cycles_model_effort_shown_in_modeline(tmp_path):
    async def body(app, pilot, prov):
        await say(pilot, app, "/model m1")
        await pilot.press("ctrl+t")
        await pilot.pause(0.2)
        assert app.sv.current_options() == {"reasoning_effort": "low"}
        assert "reasoning_effort=low" in text_of(app.screen.query_one("#modeline", Static))
        await say(pilot, app, "/variant high")
        assert app.sv.current_options()["reasoning_effort"] == "high"
        await say(pilot, app, "go")
        assert await until(pilot, lambda: bool(prov.calls))
        assert prov.calls[0]["options"] == {"reasoning_effort": "high"}

    run_app(tmp_path, [[TextDelta("ok")]], body)


def test_leader_key_chords_open_pickers(tmp_path):
    async def body(app, pilot, prov):
        await pilot.press("ctrl+x")
        await pilot.pause(0.1)
        assert app.screen.leader_active
        await pilot.press("m")  # Ctrl+X M = modèles
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
        assert "Modèles" in app.screen.title_text
        await pilot.press("escape")
        await pilot.pause(0.2)
        await pilot.press("ctrl+x")
        await pilot.press("t")  # Ctrl+X T = thèmes
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
        assert app.screen.title_text == "Thèmes"
        await pilot.press("escape")
        await pilot.pause(0.2)
        assert isinstance(app.screen, WorkScreen) and not app.screen.leader_active
        await pilot.press("m")  # sans leader : la lettre est simplement saisie
        assert app.screen.query_one("#prompt", Input).value == "m"

    run_app(tmp_path, [], body)


def test_help_lists_every_opencode_command(tmp_path):
    async def body(app, pilot, prov):
        await say(pilot, app, "/help")
        assert await until(pilot, lambda: type(app.screen).__name__ == "InfoScreen")
        from rich.console import Console
        con = Console(width=160, record=True)
        con.print(app.screen.r)
        out = con.export_text()
        for c in ["connect", "compact", "editor", "exit", "export", "help", "init", "models", "new", "redo", "sessions", "themes", "thinking", "undo", "update"]:
            assert f"/{c}" in out, c
        for k in ["ctrl+x c", "ctrl+x u", "Ctrl+T", "@fichier", "!commande"]:
            assert k in out, k

    run_app(tmp_path, [], body)


def test_thinking_toggle_and_theme_persist(tmp_path):
    async def body(app, pilot, prov):
        await say(pilot, app, "/model m1")
        await say(pilot, app, "pense")
        assert await until(pilot, lambda: not app.screen.busy and bool(app.screen.query(ThinkingBlock)))
        tb = app.screen.query(ThinkingBlock).first()
        assert not tb.has_class("visible")  # masquée par défaut
        await say(pilot, app, "/thinking")
        assert tb.has_class("visible")
        await say(pilot, app, "/thinking")
        assert not tb.has_class("visible")
        app.theme = "nord"
        app.sv.config.theme = "nord"
        from poe_neural_code.config import load_config, save_config
        save_config(app.sv.config)
        assert load_config().theme == "nord"
        assert "eclipse" in app.available_themes and "eclipse-light" in app.available_themes

    run_app(tmp_path, [[ThinkingDelta("hmm"), TextDelta("voilà")]], body)


def test_undo_command_restores_text_and_files(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "a.txt").write_text("avant")
    subprocess.run(["git", "-C", str(tmp_path), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"], check=True)

    async def body(app, pilot, prov):
        app.sv.ctx.permissions.auto_accept_edits = True
        await say(pilot, app, "/model m1")
        await say(pilot, app, "modifie a.txt")
        assert await until(pilot, lambda: not app.screen.busy and (tmp_path / "a.txt").read_text() == "après")
        await pilot.pause(0.5)
        await say(pilot, app, "/undo")
        assert await until(pilot, lambda: (tmp_path / "a.txt").read_text() == "avant")
        assert app.screen.query_one("#prompt", Input).value == "modifie a.txt"  # le message revient dans la saisie
        await say(pilot, app, "/redo")
        assert await until(pilot, lambda: (tmp_path / "a.txt").read_text() == "après")

    run_app(tmp_path, [[tc("write_file", {"path": "a.txt", "content": "après"})], [TextDelta("fait")]], body)


def test_plugin_trust_flow_and_custom_command_and_skill(tmp_path):
    (tmp_path / ".eclipse" / "plugins").mkdir(parents=True)
    (tmp_path / ".eclipse" / "plugins" / "mon.py").write_text(
        'def setup(api):\n    api.command("ping", "pong", lambda a: "pong " + a)\n')
    (tmp_path / ".eclipse" / "commands").mkdir(parents=True)
    (tmp_path / ".eclipse" / "commands" / "revue.md").write_text("---\ndescription: relit\nagent: plan\n---\nRelis $ARGUMENTS")

    async def body(app, pilot, prov):
        await say(pilot, app, "/model m1")
        assert "/ping" not in [f"/{c.name}" for c in app.sv.ext.commands()]  # pas chargé tant que non approuvé
        await say(pilot, app, "/plugins trust mon")
        assert await until(pilot, lambda: type(app.screen).__name__ == "ConfirmScreen")
        assert "sans sandbox" in app.screen.w
        await pilot.press("o")
        assert await until(pilot, lambda: "ping" in app.sv.ext.plugins.commands)
        await say(pilot, app, "/ping salut")  # commande de plugin
        await say(pilot, app, "/revue main.py")  # commande personnalisée : passe en mode plan et envoie le prompt étendu
        assert await until(pilot, lambda: bool(prov.calls))
        assert app.sv.session.agent == "plan" and "Relis main.py" in str(prov.calls[0]["messages"])
        bubbles = [b.text for b in app.screen.query(UserBubble)]
        assert bubbles == ["/revue main.py"]

    run_app(tmp_path, [[TextDelta("ok")]], body)
