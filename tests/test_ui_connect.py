"""Interface : /connect (clés d'API + agents détectés), changement de fournisseur, barres de progression."""
import asyncio
import json
import time

import httpx
from textual.widgets import Input, Static

from poe_neural_code import credentials
from poe_neural_code.provider.openai_compat import OpenAICompatProvider
from poe_neural_code.ui.app import EclipseApp
from tests.conftest import FakeProvider
from tests.test_ui_opencode import P, say, text_of, until


def run_app(tmp_path, body, size=(150, 46)):
    prov = P([])

    async def go():
        app = EclipseApp(str(tmp_path), provider=prov)
        async with app.run_test(size=size) as pilot:
            await pilot.pause(0.4)
            await body(app, pilot, prov)

    asyncio.run(go())


def test_connect_flow_with_masked_key_verification_and_model_picker(tmp_path, monkeypatch):
    monkeypatch.setattr(credentials, "_keyring", lambda: None)
    models = {"data": [{"id": "gpt-x", "context_length": 8000, "pricing": {"prompt": "0.000001", "completion": "0.000002"}}]}

    def h(req):
        if req.headers.get("authorization") == "Bearer cle-valide":
            return httpx.Response(200, json=models)
        return httpx.Response(401, json={"error": {"message": "bad"}})

    monkeypatch.setattr("poe_neural_code.services.build_provider",
                        lambda spec, transport=None: OpenAICompatProvider(spec.id, spec.base_url, lambda: credentials.get_key(spec.id, spec.key_env), label=spec.label,
                                                                          transport=httpx.MockTransport(h)))

    async def body(app, pilot, prov):
        await say(pilot, app, "/connect")
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
        assert "Connexions" in app.screen.title_text
        labels = " ".join(lab for lab, _, _ in app.screen.items)
        assert "(API)" in labels and "OpenAI" in labels and "OpenRouter" in labels and "Autre fournisseur" in labels
        assert "Claude Code" in labels and "OpenCode" in labels  # agents connus (installés ou non)
        filt = app.screen.query_one("#picker-filter", Input)
        filt.value = "openai"
        await pilot.pause(0.2)
        await pilot.press("enter")
        assert await until(pilot, lambda: type(app.screen).__name__ == "TextPromptScreen")
        assert app.screen.password and "masquée" in app.screen.title_text and app.screen.query_one("#tp-input", Input).password  # saisie masquée
        app.screen.query_one("#tp-input", Input).value = "mauvaise"
        await pilot.press("enter")
        assert await until(pilot, lambda: type(app.screen).__name__ == "WorkScreen")
        assert await until(pilot, lambda: credentials.get_key("openai") is None and app.sv.mode == "poe")  # clé refusée : rien conservé
        # 2e essai avec la bonne clé
        await say(pilot, app, "/connect")
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")
        app.screen.query_one("#picker-filter", Input).value = "openai"
        await pilot.pause(0.2)
        await pilot.press("enter")
        assert await until(pilot, lambda: type(app.screen).__name__ == "TextPromptScreen")
        app.screen.query_one("#tp-input", Input).value = "cle-valide"
        await pilot.press("enter")
        assert await until(pilot, lambda: app.sv.mode == "openai")
        assert credentials.get_key("openai") == "cle-valide" and "gpt-x" in app.sv.models
        assert await until(pilot, lambda: type(app.screen).__name__ == "PickerScreen")  # sélecteur de modèles ouvert ensuite
        assert "Modèles" in app.screen.title_text
        await pilot.press("enter")
        assert await until(pilot, lambda: app.sv.session.model == "gpt-x")
        mline = text_of(app.screen.query_one("#modeline", Static))
        assert "OpenAI" in mline and "gpt-x" in mline
        u = text_of(app.screen.query_one("#usage", Static))
        assert "Coût" in u and "Points" not in u  # hors Poe : pas de points

    run_app(tmp_path, body)


def test_provider_command_switches_to_detected_cli_agent_with_warning(tmp_path):
    async def body(app, pilot, prov):
        await say(pilot, app, "/provider opencode")
        assert app.sv.mode == "cli:opencode" and app.sv.is_cli
        notes = " ".join(text_of(w) for w in app.screen.query("NoticeLine"))
        assert "PROPRES outils" in notes and "aperçu des commandes impossible" in notes
        assert "(délégué)" in text_of(app.screen.query_one("#modeline", Static))
        u = text_of(app.screen.query_one("#usage", Static))
        assert "(délégué)" in u and "indisponible" in u
        await say(pilot, app, "/limit 50000 1h")  # la limite s'applique à l'agent délégué
        env = [e for e in app.sv.budget.envelopes() if e.kind == "claude"][0]
        assert env.scope == ["cli:opencode"] and env.token_limit == 50000 and env.period_s == 3600
        await say(pilot, app, "/provider poe")
        assert app.sv.mode == "poe"
        await say(pilot, app, "/provider nimportequoi")
        assert app.sv.mode == "poe"

    run_app(tmp_path, body)


def test_disconnect_forgets_key(tmp_path, monkeypatch):
    monkeypatch.setattr(credentials, "_keyring", lambda: None)
    credentials.set_key("openai", "sk-x")

    async def body(app, pilot, prov):
        await say(pilot, app, "/disconnect openai")
        assert credentials.get_key("openai") is None

    run_app(tmp_path, body)


def test_progress_bars_in_sidebar_for_budget_time_and_claude(tmp_path):
    async def body(app, pilot, prov):
        sv = app.sv
        await say(pilot, app, "/model m1")
        sv.budget.set_envelope(amount_points=1000, token_limit=50000, period_s=3600)
        sv.budget.add_manual(sv.session.id, 700)
        app.screen.refresh_panels()
        u = text_of(app.screen.query_one("#usage", Static))
        assert "Points" in u and "█" in u and " 70 %" in u and "Tokens" in u and "Période" in u
        await say(pilot, app, "/provider claude")
        now = time.time()
        sv.claude.info.rate = {"unifiedWindows": {"five_hour": {"utilization": 0.95, "resetsAt": now + 3600},
                                                  "seven_day": {"utilization": 0.84, "resetsAt": now + 3 * 86400}}}
        app.screen.refresh_panels()
        u = text_of(app.screen.query_one("#usage", Static))
        assert "Fenêtre 5 h" in u and "95 %" in u and "Écoulé" in u and "Fenêtre 7 j" in u and "84 %" in u and "plus vite que le temps" in u
        assert "Budget « " not in u  # abonnement : pas de budget en points affiché

    run_app(tmp_path, body)


def test_usage_command_detail_by_model_and_kinds_not_mixed(tmp_path):
    async def body(app, pilot, prov):
        sv = app.sv
        for m, tin, tout, tk, usd in (("m1", 1000, 100, "measured", 0.002), ("cli:opencode", 300, 80, "estimated", None)):
            sv.budget.commit(None, session_id=sv.session.id, model=m, tokens_in=tin, tokens_out=tout, tokens_kind=tk, points=None, points_kind="unavailable", usd=usd)
        sv.budget.add_manual(sv.session.id, 12.5)
        await say(pilot, app, "/usage")
        assert await until(pilot, lambda: type(app.screen).__name__ == "InfoScreen")
        from rich.console import Console
        con = Console(width=170, record=True)
        con.print(app.screen.r)
        out = con.export_text()
        assert "Aujourd'hui — par modèle" in out and "Cette semaine" in out and "Ce mois" in out
        assert "m1" in out and "cli:opencode" in out and "1 000 | 0" in out and "0 | 300" in out and "(mesurés | estimés)" in out  # mesurés et estimés dans des colonnes séparées
        assert "12.5 [manual]" in out and "$0.0020" in out and "Registre LOCAL" in out
        await pilot.press("escape")
        await pilot.press("ctrl+x")
        await pilot.press("i")  # raccourci leader Ctrl+X I
        assert await until(pilot, lambda: type(app.screen).__name__ == "InfoScreen")

    run_app(tmp_path, body)
