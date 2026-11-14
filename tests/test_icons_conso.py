"""Aucun emoji dans l'application ; icônes Nerd Font vérifiées ; conso claire ; /define-token masqué pour les abonnements."""
import json
import pathlib
import re

from poe_neural_code.ui import icons as I
from tests.test_ui_opencode import say, text_of, until
from tests.test_ui_connect import run_app

SRC = pathlib.Path(__file__).parent.parent / "src" / "poe_neural_code"
EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF️⏩-⏺ℹⓂ⭐⭕]")


def test_no_emoji_anywhere_in_the_application():
    hits = []
    for f in SRC.rglob("*.py"):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if EMOJI.search(line):
                hits.append(f"{f.name}:{n}: {line.strip()[:80]}")
    assert hits == [], "\n".join(hits)


def test_icons_are_real_nerd_font_glyphs_with_text_fallback():
    table = I.names()
    assert len(table) >= 50
    for name, (code, official, fallback) in table.items():
        assert official.startswith(("nf-md-", "nf-dev-", "nf-cod-")), name
        assert 0xE000 <= code <= 0xF8FF or 0xF0000 <= code <= 0xFFFFD, name  # zones d'usage privé (Nerd Fonts)
        assert fallback and not EMOJI.search(fallback), name
    glyphs = pathlib.Path("/tmp/claude-1000/nf/glyphnames.json")
    if glyphs.exists():  # liste officielle Nerd Fonts téléchargée : chaque nom et code correspond
        d = json.loads(glyphs.read_text())
        for name, (code, official, _f) in table.items():
            key = official[3:]
            assert key in d and int(d[key]["code"], 16) == code, name
    assert I.configure("text") == "text" and I.get("ok") == "v"
    assert I.configure("nerd") == "nerd" and I.get("ok") == chr(0xF05E1)
    assert I.tool("run_command") == chr(0xF018D) and I.tool("mcp__srv__x") == I.get("mcp")


def test_consumption_is_split_in_titled_panels_poe(tmp_path):
    async def body(app, pilot, prov):
        sv = app.sv
        await say(pilot, app, "/model m1")
        sv.budget.set_envelope(amount_points=600, period_s=1800)
        app.screen.refresh_panels()
        u = text_of(app.screen.query_one("#usage"))
        order = [u.index(t) for t in ("Fournisseur", "Cette session", "Budget « ", "Totaux locaux")]
        assert order == sorted(order)  # ordre logique, un cadre par partie
        assert u.count("╭─") >= 4 and "mesuré = renvoyé" in u

    run_app(tmp_path, body)


def test_subscription_hides_define_token_and_point_budgets(tmp_path):
    async def body(app, pilot, prov):
        sv = app.sv
        sv.budget.set_envelope(amount_points=600, period_s=1800)  # budget en points (Poe)
        await say(pilot, app, "/provider claude")
        app.screen.refresh_panels()
        u = text_of(app.screen.query_one("#usage"))
        assert "Abonnement Claude Code" in u and "Budget « " not in u and "Points" not in u
        names = [c.name for c in app.screen._commands()]
        assert "define-token" not in names and "rate" not in names and "spent" not in names and "limit" not in names and "claude-limit" in names
        p = app.screen.query_one("#prompt")
        p.value = "/def"
        await pilot.pause(0.2)
        assert not any("define-token" in str(o) for o in app.screen._preview_items)  # absent de l'aperçu des commandes
        await say(pilot, app, "/define-token")
        notes = " ".join(text_of(w) for w in app.screen.query("NoticeLine"))
        assert "gérée par l'abonnement Claude Code" in notes and "/limit" in notes
        assert type(app.screen).__name__ == "WorkScreen"  # aucune fenêtre de budget ouverte
        await say(pilot, app, "/limit 100000 5h")  # une limite propre à Eclipse reste possible…
        app.screen.refresh_panels()
        u = text_of(app.screen.query_one("#usage"))
        assert "Limite Eclipse" in u and "100 000" in u  # …et s'affiche alors
        await say(pilot, app, "/provider opencode")
        app.screen.refresh_panels()
        u = text_of(app.screen.query_one("#usage"))
        assert "Abonnement" in u and "gérés par l'abonnement OpenCode" in u and "Budget « " not in u
        await say(pilot, app, "/provider poe")
        assert "define-token" in [c.name for c in app.screen._commands()]

    run_app(tmp_path, body)
