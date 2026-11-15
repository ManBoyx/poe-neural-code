"""Fonctions 0.2.0 : web_fetch, images, paramètres standard, dossiers en plus, consignes, prompts intégrés, fork, diagnostic, contexte, gratuit, interface."""
import asyncio
import base64
import json
import sys
from pathlib import Path

import httpx
import pytest

from poe_neural_code import agent as A
from poe_neural_code import cli_agents as CA
from poe_neural_code.config import Config
from poe_neural_code.extensions import commands as C
from poe_neural_code.extensions.refs import find_images
from poe_neural_code.provider.base import ModelInfo, ParamSpec, TextDelta
from poe_neural_code.provider.openai_compat import parse_generic_model
from poe_neural_code.services import create_services
from poe_neural_code.session import Session, delete_session, list_sessions
from poe_neural_code.tools.base import TodoList, ToolContext
from poe_neural_code.tools.permissions import PermissionManager
from poe_neural_code.tools.web_tool import WebFetch, html_to_text
from poe_neural_code.tools.workspace import Workspace
from tests.conftest import MODEL, FakeProvider, tc
from tests.test_ui_opencode import P, say, text_of, until
from tests.test_ui_connect import run_app

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
VISION = ModelInfo("vision", 100_000, 8000, 1e-6, 3e-6, True, input_modalities=["text", "image"])


def ctx(tmp_path, asker=None):
    return ToolContext(Workspace(tmp_path), Config(), PermissionManager(asker), TodoList(), asyncio.Event())


def mk(tmp_path, turns, model=MODEL, **cfg):
    proj = tmp_path / "proj"
    proj.mkdir(parents=True, exist_ok=True)
    ev = []

    async def asker(r):
        return "once"

    sv = create_services(proj, provider=FakeProvider(turns), asker=asker, config=Config(**cfg))
    sv.models[model.id] = model
    sv.session.model = model.id
    sv.agent.emit = ev.append
    return sv, ev, proj


# ------------------------------------------------------------------ web_fetch
def test_web_fetch_html_to_text_and_permission(tmp_path):
    html = "<html><head><title>Doc X</title><style>.a{}</style></head><body><h1>Titre</h1><p>Bonjour <b>monde</b></p><script>alert(1)</script></body></html>"
    t = WebFetch(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=html, headers={"content-type": "text/html"})))
    req = asyncio.run(t.prepare({"url": "https://docs.exemple.org/x"}, ctx(tmp_path)))
    assert req.kind == "web" and "docs.exemple.org" in req.summary and "non fiable" in req.warnings[0]
    r = asyncio.run(t.run({"url": "https://docs.exemple.org/x"}, ctx(tmp_path)))
    assert r.ok and r.output.startswith("# Doc X") and "Bonjour monde" in r.output and "alert" not in r.output and ".a{}" not in r.output
    assert asyncio.run(WebFetch(transport=httpx.MockTransport(lambda r: httpx.Response(404))).run({"url": "https://x.org"}, ctx(tmp_path))).output == "HTTP 404"
    assert t.validate({"url": "file:///etc/passwd"})  # seuls http/https


def test_web_fetch_flags_private_addresses(tmp_path):
    req = asyncio.run(WebFetch().prepare({"url": "http://localhost:8080/admin"}, ctx(tmp_path)))
    assert req.outside and any("LOCALE" in w for w in req.warnings)  # jamais couvert par une autorisation de session


def test_html_to_text_minimal():
    title, text = html_to_text("<title>T</title><div>a</div><div>b</div>")
    assert title == "T" and "a" in text and "b" in text


# ------------------------------------------------------------------ images
def test_image_sent_to_vision_model_and_stripped_after(tmp_path):
    sv, ev, proj = mk(tmp_path, [[TextDelta("je vois un pixel")]], model=VISION)
    (proj / "pix.png").write_bytes(PNG)
    asyncio.run(sv.run_user_turn("Que vois-tu sur @pix.png ?"))
    user = [m for m in sv.provider.calls[0]["messages"] if m["role"] == "user"][-1]
    assert isinstance(user["content"], list) and user["content"][1]["type"] == "image_url"
    assert user["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    hist = [m for m in sv.agent.messages if m["role"] == "user"][-1]
    assert isinstance(hist["content"], str) and "image jointe" in hist["content"]  # retirée de l'historique après le tour
    assert "pix.png" in sv.memory.archive_rows(sv.session.conversation_id)[0]["content"]


def test_image_not_sent_to_text_only_model(tmp_path):
    sv, ev, proj = mk(tmp_path, [[TextDelta("ok")]])
    (proj / "pix.png").write_bytes(PNG)
    asyncio.run(sv.run_user_turn("regarde @pix.png"))
    assert any(isinstance(e, A.StatusEvent) and "entrée image" in e.text for e in ev)
    assert all(isinstance(m["content"], str) for m in sv.provider.calls[0]["messages"])


def test_find_images_stays_in_project_and_token_estimate_ignores_base64(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    (tmp_path.parent / "out.png").write_bytes(PNG)
    assert find_images("@a.png @../out.png @nope.png", tmp_path) == [(tmp_path / "a.png").resolve()]
    big = {"role": "user", "content": [{"type": "text", "text": "x"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64," + "A" * 400_000}}]}
    assert A.msg_tokens(big) < 1100  # une image ≈ 1 000 tokens, pas 100 000


def test_claude_runner_sends_image_via_stream_json(tmp_path, monkeypatch):
    from tests.test_claude_mode import FAKE, assistant, init, result
    sc, log = tmp_path / "sc.json", tmp_path / "log.jsonl"
    sc.write_text(json.dumps([init(), assistant("ok"), result()]))
    monkeypatch.setenv("FAKE_CLAUDE_SCENARIO", str(sc))
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    sv, ev, proj = mk(tmp_path, [])
    sv.session.mode = "claude"
    sv.claude.claude_cmd = [sys.executable, FAKE]
    sv.claude.emit = ev.append
    (proj / "pix.png").write_bytes(PNG)

    async def go():
        await sv.run_user_turn("décris @pix.png")
        await sv.bridge.stop()

    asyncio.run(go())
    e = json.loads(log.read_text().splitlines()[0])
    assert "--input-format" in e["argv"] and e["argv"][e["argv"].index("--input-format") + 1] == "stream-json"
    msg = json.loads(e["stdin"])
    blocks = msg["message"]["content"]
    assert blocks[0]["type"] == "text" and blocks[1]["type"] == "image" and blocks[1]["source"]["media_type"] == "image/png"


def test_delegated_agent_gets_file_flag():
    op = CA.get_adapter("opencode")
    cmd, _ = CA.build_command(op, "/b/o", "décris", files=[Path("/p/a.png")])
    assert cmd[-3:] == ["--file", "/p/a.png", "décris"]
    gm = CA.get_adapter("gemini")
    cmd, _ = CA.build_command(gm, "/b/g", "décris", files=[Path("/p/a.png")])
    assert "[Fichier joint : /p/a.png]" in cmd[-1]  # pas d'option connue : chemin mentionné


# ------------------------------------------------------------------ paramètres standard
def test_standard_sampling_params():
    m = parse_generic_model({"id": "x", "supported_parameters": ["tools", "temperature", "top_p", "seed", "top_k"]})
    assert [p.name for p in m.params] == ["temperature", "top_p", "seed", "top_k"]
    unknown = parse_generic_model({"id": "gpt-y"})
    names = [p.name for p in unknown.params]
    assert names == ["temperature", "top_p", "seed"] and "non vérifiée" in unknown.params[0].description
    assert not parse_generic_model({"id": "z", "supported_parameters": ["tools"]}).params  # le catalogue dit non : rien d'ajouté
    assert parse_generic_model({"id": "f", "pricing": {"prompt": "0", "completion": "0"}}).free
    assert parse_generic_model({"id": "v", "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}}).accepts_images
    zen = parse_generic_model({"id": "z", "modalities": {"input": ["text", "image"], "output": ["text"]}})
    assert zen.accepts_images and zen.chat_text


# ------------------------------------------------------------------ dossiers, consignes, prompts, fork
def test_add_dir_allows_extra_root_and_survives_resume(tmp_path):
    sv, ev, proj = mk(tmp_path, [])
    other = tmp_path / "libs"
    other.mkdir()
    assert not sv.ctx.workspace.resolve(other / "x.py")[1]
    sv.add_dir(str(other))
    assert sv.ctx.workspace.resolve(other / "x.py")[1] and not sv.ctx.workspace.resolve(tmp_path / "ailleurs.py")[1]
    sv2 = create_services(proj, resume=sv.session.id, provider=FakeProvider([]), config=Config())
    assert other.resolve() in sv2.ctx.workspace.roots()
    with pytest.raises(NotADirectoryError):
        sv.add_dir(str(tmp_path / "inexistant"))


def test_user_instructions_in_system_prompt(tmp_path):
    from poe_neural_code.paths import data_dir
    sv, ev, proj = mk(tmp_path, [[TextDelta("ok")]])
    (data_dir() / "instructions.md").write_text("Réponds toujours en tutoyant.")
    (proj / ".eclipse").mkdir()
    (proj / ".eclipse" / "instructions.md").write_text("Style : black.")
    asyncio.run(sv.run_user_turn("x"))
    sysm = sv.provider.calls[0]["messages"][0]["content"]
    assert "tutoyant" in sysm and "Style : black" in sysm and "jamais des permissions" in sysm


def test_builtin_prompt_commands_and_override(tmp_path):
    cmds = C.all_commands()
    for n in ("review", "explain", "tests", "fix", "commit", "plan"):
        assert C.resolve(n, cmds).kind == "custom", n
    assert C.resolve("review", cmds).agent == "plan"
    custom = {"review": C.Command("review", "ma revue", kind="custom", template="MA REVUE")}
    assert C.resolve("review", C.all_commands(custom)).template == "MA REVUE"  # remplaçable
    for n in ("free", "retry", "edit", "fork", "add-dir", "system", "config", "doctor", "context", "diff", "login", "logout", "attach"):
        assert C.resolve(n, cmds), n
    assert C.resolve("regenerate", cmds).name == "retry" and C.resolve("settings", cmds).name == "config"


def test_fork_session_copies_state_and_archives(tmp_path):
    sv, ev, proj = mk(tmp_path, [[TextDelta("réponse")]])
    sv.ctx.todos.add("t1")
    sv.session.todos = sv.ctx.todos.to_json()
    asyncio.run(sv.run_user_turn("question"))
    f = sv.fork_session()
    assert f.id != sv.session.id and f.conversation_id != sv.session.conversation_id and "(fork)" in f.title
    assert [r["content"] for r in sv.memory.archive_rows(f.conversation_id)] == [r["content"] for r in sv.memory.archive_rows(sv.session.conversation_id)]
    assert Session.load(f.id).todos == sv.session.todos and Session.load(f.id).messages == sv.session.messages


def test_delete_session_keeps_memory(tmp_path):
    sv, ev, proj = mk(tmp_path, [[TextDelta("x")]])
    asyncio.run(sv.run_user_turn("q"))
    sid, conv = sv.session.id, sv.session.conversation_id
    assert delete_session(sid) and sid not in [s.id for s in list_sessions()]
    assert sv.memory.archive_rows(conv)  # archives conservées
    assert not delete_session(sid)


# ------------------------------------------------------------------ diagnostic et contexte
def test_doctor_reports_checks(tmp_path):
    from poe_neural_code.diagnostics import doctor
    sv, ev, proj = mk(tmp_path, [])
    checks = asyncio.run(doctor(sv, transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"data": []}))))
    names = {c.name: c for c in checks}
    assert names["Python ≥ 3.11"].status == "ok" and names["SQLite FTS5 (recherche mémoire)"].status == "ok"
    assert names["Réseau : Poe"].status == "ok" and names["Projet sous Git"].status == "warn"
    assert names["Annulation des fichiers (/undo, /diff)"].status == "ok" and "fantôme" in names["Annulation des fichiers (/undo, /diff)"].detail
    assert names["Fournisseur actif"].status in ("ok", "fail")


def test_context_breakdown(tmp_path):
    from poe_neural_code.diagnostics import context_breakdown
    sv, ev, proj = mk(tmp_path, [[TextDelta("ok")]])
    asyncio.run(sv.run_user_turn("bonjour"))
    d = context_breakdown(sv)
    names = [n for n, _ in d["parts"]]
    assert names[0] == "Instructions de base d'Eclipse" and any(n.startswith("Historique (") for n in names) and any(n.startswith("Définitions d'outils") for n in names)
    assert d["total"] == sum(n for _, n in d["parts"]) and d["window"] == 100_000


# ------------------------------------------------------------------ gratuit
def test_free_sources_honest_and_detect(monkeypatch):
    from poe_neural_code import free as FR

    async def oc():
        return ["opencode/beam-free", "opencode/glm-5.3-flash-free"]

    async def orr():
        return [{"id": "a:free", "supported_parameters": ["tools"]}, {"id": "b:free", "supported_parameters": []}]

    async def ol():
        return False, []

    monkeypatch.setattr(FR, "opencode_free_models", oc)
    monkeypatch.setattr(FR, "openrouter_free_models", orr)
    monkeypatch.setattr(FR, "ollama_status", ol)
    srcs = {s.id: s for s in asyncio.run(FR.sources())}
    assert srcs["opencode"].ready and "2 modèles gratuits" in srcs["opencode"].status and "aperçu des commandes impossible" in srcs["opencode"].tradeoff
    assert not srcs["openrouter"].ready and "dont 1 avec outils" in srcs["openrouter"].status and "clé requise" in srcs["openrouter"].status
    assert not srcs["ollama"].ready and "lent" in srcs["ollama"].tradeoff
    assert {"groq", "google", "mistral", "cerebras", "github"} <= set(srcs)


def test_openrouter_free_filter_parses_catalog():
    from poe_neural_code import free as FR
    data = {"data": [{"id": "a:free", "pricing": {"prompt": "0", "completion": "0"}}, {"id": "b", "pricing": {"prompt": "0.1", "completion": "0.2"}},
                     {"id": "c", "pricing": {"prompt": "0", "completion": "0"}}]}
    out = asyncio.run(FR.openrouter_free_models(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=data))))
    assert [m["id"] for m in out] == ["a:free", "c"]


# ------------------------------------------------------------------ interface 0.2.0
def test_ui_multiline_history_topbar_footer_and_welcome(tmp_path):
    async def body(app, pilot, prov):
        from poe_neural_code.ui.widgets import TurnFooter, WelcomeCard
        scr = app.screen
        assert scr.query(WelcomeCard)  # carte d'accueil au démarrage
        await say(pilot, app, "/model m1")
        p = scr.query_one("#prompt")
        p.focus()
        p.value = "ligne 1"
        await pilot.press("shift+enter")
        p.insert("ligne 2")
        assert p.text == "ligne 1\nligne 2" and not scr.busy  # Maj+Entrée : nouvelle ligne, pas d'envoi
        await pilot.press("enter")
        assert await until(pilot, lambda: not scr.busy and bool(scr.query(TurnFooter)))
        assert not scr.query(WelcomeCard)  # la carte disparaît au premier échange
        foot = text_of(scr.query(TurnFooter).last())
        from poe_neural_code.ui import icons as I
        assert I.get("ok") in foot and " s" in foot and "tok [" in foot
        assert prov.calls[0]["messages"][-1]["content"] == "ligne 1\nligne 2"
        top = text_of(scr.query_one("#topbar"))
        assert "ECLIPSE" in top and "BUILD" in top and "m1" in top and "session" in top
        await pilot.press("up")  # historique
        assert p.text == "ligne 1\nligne 2"

    prov = P([[TextDelta("ok")]])

    async def go():
        from poe_neural_code.ui.app import EclipseApp
        app = EclipseApp(str(tmp_path), provider=prov)
        async with app.run_test(size=(150, 46)) as pilot:
            await pilot.pause(0.4)
            await body(app, pilot, prov)

    asyncio.run(go())


def test_ui_tool_block_collapses_and_toggles(tmp_path):
    async def body(app, pilot, prov):
        from poe_neural_code.ui.widgets import ToolBlock
        b, b2 = ToolBlock("read_file", "a.py"), ToolBlock("run_command", "pytest")
        app.screen.add(b)
        app.screen.add(b2)
        await pilot.pause(0.1)
        assert not b.details and b2.details  # lecture repliée par défaut, commande dépliée
        b.finish(True, "l1\nl2\nl3")
        assert "3 lignes" in text_of(b) and "l2" not in text_of(b)
        b.on_click()
        assert b.details and "l2" in text_of(b)
        e = ToolBlock("read_file", "x")
        app.screen.add(e)
        e.finish(False, "fichier introuvable")
        assert e.details  # une erreur se montre toujours

    run_app(tmp_path, body)


def test_ui_sidebar_tabs_and_new_commands(tmp_path):
    async def body(app, pilot, prov):
        scr = app.screen
        from textual.widgets import TabbedContent
        tabs = scr.query_one("#sidebar", TabbedContent)
        assert [p.id for p in tabs.query("TabPane")] == ["tab-session", "tab-usage", "tab-tools"]
        assert "PERMISSIONS" in text_of(scr.query_one("#ext"))
        (tmp_path / "pix.png").write_bytes(PNG)
        await say(pilot, app, "/attach pix.png")
        from poe_neural_code.ui import icons as I
        assert scr.pending_attachments and f"{I.get('attach')} 1" in text_of(scr.query_one("#modeline"))
        await say(pilot, app, "/attach")
        assert not scr.pending_attachments
        other = tmp_path.parent / "autre"
        other.mkdir(exist_ok=True)
        await say(pilot, app, f"/add-dir {other}")
        assert other.resolve() in app.sv.ctx.workspace.roots()
        await say(pilot, app, "/system set Sois bref.")
        from poe_neural_code.paths import data_dir
        assert (data_dir() / "instructions.md").read_text().strip() == "Sois bref."
        await say(pilot, app, "/context")
        assert await until(pilot, lambda: type(app.screen).__name__ == "InfoScreen")
        await pilot.press("escape")
        await pilot.pause(0.2)
        await say(pilot, app, "/config")
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
        assert any(v == "desktop_notify" for _, v, _ in app.screen.items)
        app.screen.query_one("#picker-filter").value = "desktop_notify"
        await pilot.pause(0.2)
        await pilot.press("enter")  # booléen : bascule
        assert await until(pilot, lambda: app.sv.config.desktop_notify is True)
        await pilot.press("escape")

    run_app(tmp_path, body)


def test_ui_models_free_filter(tmp_path):
    free = ModelInfo("gratuit-1", 100_000, 8000, 0.0, 0.0, True)
    paid = ModelInfo("payant-1", 100_000, 8000, 1e-6, 1e-6, True)

    class Q(P):
        async def list_models(self):
            return [free, paid]

    async def go():
        from poe_neural_code.ui.app import EclipseApp
        app = EclipseApp(str(tmp_path), provider=Q([]))
        async with app.run_test(size=(150, 46)) as pilot:
            await pilot.pause(0.4)
            await say(pilot, app, "/models free")
            assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
            assert [v for _, v, _ in app.screen.items] == ["gratuit-1"] and "gratuits" in app.screen.title_text
            await pilot.press("escape")
            await pilot.pause(0.2)
            await say(pilot, app, "/models")
            assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
            assert [v for _, v, _ in app.screen.items][:1] == ["gratuit-1"] and "gratuit" in app.screen.items[0][2]

    asyncio.run(go())


def test_ui_sessions_delete_with_ctrl_d(tmp_path):
    other = Session.new(str(tmp_path), 1, 1, None)
    other.save()

    async def body(app, pilot, prov):
        await say(pilot, app, "/sessions")
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
        app.screen.query_one("#picker-filter").value = other.id
        await pilot.pause(0.2)
        await pilot.press("ctrl+d")
        assert await until(pilot, lambda: type(app.screen).__name__ == "ConfirmScreen")
        await pilot.press("o")
        assert await until(pilot, lambda: other.id not in [s.id for s in list_sessions()])

    run_app(tmp_path, body)


def test_applied_diff_shown_even_without_permission_dialog(tmp_path):
    sv, ev, proj = mk(tmp_path, [[tc("write_file", {"path": "a.py", "content": "x = 2\n"})], [TextDelta("ok")]])
    (proj / "a.py").write_text("x = 1\n")
    sv.ctx.permissions.set_mode("edits")
    asyncio.run(sv.run_user_turn("modifie"))
    d = [e for e in ev if isinstance(e, A.DiffShown)]
    assert d and "-x = 1" in d[0].diff and "+x = 2" in d[0].diff and d[0].path == "a.py"


def test_tool_summaries_are_readable():
    from poe_neural_code.ui.app import tool_summary
    assert tool_summary("todo_write", {"items": [{"content": "a", "status": "done"}, {"content": "b"}]}) == "2 tâche(s), 1 terminée(s)"
    assert tool_summary("run_command", {"command": "pytest -q"}) == "pytest -q"
    assert tool_summary("search_files", {"pattern": "def x", "glob": "*.py"}) == "« def x » dans *.py"


def test_missing_project_dir_gives_clear_error_not_crash(tmp_path):
    with pytest.raises(FileNotFoundError, match="introuvable"):
        create_services(tmp_path / "disparu", provider=FakeProvider([]), config=Config())
    proj = tmp_path / "p"
    proj.mkdir()
    sv = create_services(proj, provider=FakeProvider([]), config=Config())
    sv.session.save()
    import shutil as sh
    sh.rmtree(proj)
    with pytest.raises(FileNotFoundError, match="n'existe plus"):
        create_services(".", resume=sv.session.id, provider=FakeProvider([]), config=Config())
    from poe_neural_code.undo import Snapshots
    assert not Snapshots(tmp_path / "rien").available  # aucun plantage
