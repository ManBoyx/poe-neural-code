import asyncio
import json
import os
import stat
import sys

import httpx
import pytest

from poe_neural_code import credentials
from poe_neural_code import providers as P
from poe_neural_code.config import Config
from poe_neural_code.provider.base import NotConfigured, ProviderError, TextDelta, ToolCall, Usage
from poe_neural_code.provider.openai_compat import OpenAICompatProvider, parse_generic_model
from poe_neural_code.services import create_services
from tests.conftest import FakeProvider


def sse(*datas):
    return "".join(f"data: {json.dumps(d) if not isinstance(d, str) else d}\n\n" for d in datas)


def mk(handler, key="k", required=True):
    return OpenAICompatProvider("x", "https://api.example.com/v1", lambda: key, label="Exemple", key_env="X_API_KEY", key_required=required,
                                transport=httpx.MockTransport(handler))


async def collect(p, options=None):
    return [e async for e in p.stream("m", [{"role": "user", "content": "hi"}], [{"type": "function"}], 50, options=options)]


def test_openrouter_style_model_parsing():
    m = parse_generic_model({"id": "a/b:free", "context_length": 131072, "pricing": {"prompt": "0.000001", "completion": "0.000002"},
                             "supported_parameters": ["tools", "reasoning", "reasoning_effort", "max_tokens"], "top_provider": {"max_completion_tokens": 8192}})
    assert m.supports_tools and m.prompt_price == 1e-6 and m.max_output == 8192 and m.reasoning and m.chat_text
    assert [p.name for p in m.params] == ["reasoning_effort"] and m.params[0].choices == ["low", "medium", "high"]
    no_tools = parse_generic_model({"id": "c", "supported_parameters": ["max_tokens"]})
    assert not no_tools.supports_tools
    plain = parse_generic_model({"id": "gpt-x", "object": "model", "owned_by": "openai"})
    assert plain.prompt_price is None and plain.context_length is None and plain.supports_tools  # inconnu : jamais inventé
    assert not parse_generic_model({"id": "text-embedding-3-small"}).chat_text


def test_stream_uses_base_url_auth_tools_usage_and_options():
    seen = {}

    def h(req):
        seen.update(url=str(req.url), auth=req.headers["authorization"], body=json.loads(req.content))
        return httpx.Response(200, text=sse({"choices": [{"delta": {"content": "Sa"}}]}, {"choices": [{"delta": {"content": "lut"}}]},
                                           {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{}"}}]}}]},
                                           {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 3}}, "[DONE]"))

    ev = asyncio.run(collect(mk(h), {"reasoning_effort": "high"}))
    assert seen["url"] == "https://api.example.com/v1/chat/completions" and seen["auth"] == "Bearer k"
    assert seen["body"]["reasoning_effort"] == "high" and seen["body"]["tools"] and seen["body"]["max_tokens"] == 50
    assert "".join(e.text for e in ev if isinstance(e, TextDelta)) == "Salut"
    assert [e for e in ev if isinstance(e, Usage)][0].completion_tokens == 3 and any(isinstance(e, ToolCall) for e in ev)


def test_options_refused_then_retried_without():
    bodies = []

    def h(req):
        b = json.loads(req.content)
        bodies.append(b)
        if "reasoning_effort" in b:
            return httpx.Response(400, json={"error": {"message": "unknown parameter"}})
        return httpx.Response(200, text=sse({"choices": [{"delta": {"content": "ok"}}]}, "[DONE]"))

    ev = asyncio.run(collect(mk(h), {"reasoning_effort": "high"}))
    assert len(bodies) >= 2 and "reasoning_effort" not in bodies[-1] and any(type(e).__name__ == "Notice" for e in ev)


def test_not_configured_names_connect_and_env_and_local_needs_no_key():
    p = mk(lambda r: httpx.Response(200), key=None)
    assert not p.configured()
    with pytest.raises(NotConfigured) as e:
        asyncio.run(collect(p))
    assert "/connect" in str(e.value) and "X_API_KEY" in str(e.value) and "simulée" in str(e.value) and "Exemple" in str(e.value)
    local = mk(lambda r: httpx.Response(200, text=sse({"choices": [{"delta": {"content": "x"}}]}, "[DONE]")), key=None, required=False)
    assert local.configured() and asyncio.run(collect(local))


def test_verify_key():
    assert asyncio.run(mk(lambda r: httpx.Response(401, json={})).verify())[0] is False
    ok, msg = asyncio.run(mk(lambda r: httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}]})).verify())
    assert ok and "2 modèles" in msg
    ok, msg = asyncio.run(mk(lambda r: httpx.Response(500)).verify())
    assert ok and "non vérifiable" in msg  # panne réseau ≠ clé invalide


def test_http_errors_explicit():
    with pytest.raises(ProviderError) as e:
        asyncio.run(collect(mk(lambda r: httpx.Response(402, json={"error": {"message": "no credit"}}))))
    assert e.value.status == 402 and "crédits" in str(e.value)


# ------------------------------------------------------------------ clés
def test_credentials_keyring_only_env_priority_and_delete(monkeypatch, fake_keyring):
    assert credentials.get_key("prov", "PROV_KEY") is None
    where = credentials.set_key("prov", "  secret-abc-123  ")
    assert "trousseau" in where and credentials.get_key("prov") == "secret-abc-123"
    assert fake_keyring.store[(credentials.SERVICE, "prov")] == "secret-abc-123"
    assert not credentials._legacy_file().exists()  # rien sur le disque
    monkeypatch.setenv("PROV_KEY", "from-env")
    assert credentials.get_key("prov", "PROV_KEY") == "from-env"  # l'environnement est prioritaire
    monkeypatch.delenv("PROV_KEY")
    assert credentials.delete_key("prov") and credentials.get_key("prov") is None
    assert credentials.mask("sk-abcdefghijkl") == "sk-…jkl" and credentials.mask(None) == "—" and "secret" not in credentials.mask("secret-key-long")


def test_no_keyring_means_refusal_never_plaintext(monkeypatch):
    monkeypatch.setattr(credentials, "_keyring", lambda: None)
    with pytest.raises(credentials.KeyringUnavailable, match="OPENAI_API_KEY"):
        credentials.set_key("openai", "sk-secret", "OPENAI_API_KEY")
    assert not credentials._legacy_file().exists()
    assert "variables d'environnement" in credentials.storage_kind()
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    assert credentials.get_key("openai", "OPENAI_API_KEY") == "sk-env"


def test_legacy_plaintext_file_is_migrated_then_deleted(fake_keyring):
    f = credentials._legacy_file()
    f.write_text(json.dumps({"openrouter": "sk-or-ancienne"}), encoding="utf-8")
    assert credentials.get_key("openrouter") == "sk-or-ancienne"
    assert not f.exists() and fake_keyring.store[(credentials.SERVICE, "openrouter")] == "sk-or-ancienne"


def test_insecure_backends_are_rejected():
    class Fail:  # keyring.backends.fail.Keyring
        priority = 0
    Fail.__module__ = "keyring.backends.fail"

    class Plain:  # keyrings.alt.file.PlaintextKeyring
        priority = 0.5
    Plain.__module__ = "keyrings.alt.file"

    class Secret:
        priority = 5
    Secret.__module__ = "keyring.backends.SecretService"

    class Chain:
        def __init__(self, *b):
            self.backends = list(b)
    assert not credentials._secure(Fail()) and not credentials._secure(Plain())
    assert credentials._secure(Secret()) and credentials._secure(Chain(Plain(), Secret())) and not credentials._secure(Chain(Plain()))


def test_registry_presets_and_custom(monkeypatch):
    ids = [s.id for s in P.all_specs()]
    for need in ("poe", "openrouter", "openai", "anthropic", "google", "mistral", "groq", "deepseek", "xai", "together", "ollama", "lmstudio"):
        assert need in ids
    assert not P.get_spec("ollama").key_required and P.get_spec("openai").key_env == "OPENAI_API_KEY"
    assert P.get_spec("google").verified.startswith("adresse NON vérifiée")  # honnête sur ce qui n'est pas vérifié
    P.save_custom(P.ProviderSpec("mine", "Mon serveur", "https://x.test/v1", "MINE_API_KEY", custom=True))
    assert P.get_spec("mine").base_url == "https://x.test/v1" and P.get_spec("mine").custom
    assert not P.has_credentials(P.get_spec("openai"))
    credentials.set_key("openai", "sk-test")
    assert P.has_credentials(P.get_spec("openai"))
    assert P.build_provider(P.get_spec("poe")).name == "poe" and P.build_provider(P.get_spec("openai")).base_url == "https://api.openai.com/v1"


# ------------------------------------------------------------------ services
def test_connect_provider_switches_loads_models_and_remembers_models(tmp_path, monkeypatch):
    models = {"data": [{"id": "gpt-x", "context_length": 1000, "pricing": {"prompt": "0.000001", "completion": "0.000002"}}, {"id": "text-embedding-3"}]}

    def h(req):
        if req.headers.get("authorization") == "Bearer bonne-cle":
            return httpx.Response(200, json=models)
        return httpx.Response(401, json={"error": {"message": "bad"}})

    monkeypatch.setattr("poe_neural_code.services.build_provider",
                        lambda spec, transport=None: OpenAICompatProvider(spec.id, spec.base_url, lambda: credentials.get_key(spec.id, spec.key_env), label=spec.label,
                                                                          transport=httpx.MockTransport(h)))
    proj = tmp_path / "p"
    proj.mkdir()
    sv = create_services(proj, provider=FakeProvider([]), config=Config())
    ok, msg = asyncio.run(sv.connect_provider("openai", "mauvaise"))
    assert not ok and "401" in msg and credentials.get_key("openai", "OPENAI_API_KEY") is None  # clé refusée : non conservée
    assert sv.mode == "poe"
    ok, msg = asyncio.run(sv.connect_provider("openai", "bonne-cle"))
    assert ok and sv.mode == "openai" and sv.mode_label == "OpenAI" and "gpt-x" in sv.models and credentials.get_key("openai") == "bonne-cle"
    assert "2 modèles" in msg
    assert not sv.is_cli and not getattr(sv.provider, "points_based", True)
    sv.session.model = "gpt-x"
    sv.set_mode("poe")  # retour à Poe : le modèle choisi chez OpenAI est mémorisé
    assert sv.session.provider_models["openai"] == "gpt-x" and sv.session.model is None
    sv.set_mode("openai")
    assert sv.session.model == "gpt-x"
    with pytest.raises(KeyError):
        sv.set_mode("inconnu")


def test_non_poe_provider_records_usd_estimate_and_no_points(tmp_path):
    from poe_neural_code.provider.base import ModelInfo
    proj = tmp_path / "p"
    proj.mkdir()

    def h(req):
        return httpx.Response(200, text=sse({"choices": [{"delta": {"content": "ok"}}]}, {"choices": [], "usage": {"prompt_tokens": 1000, "completion_tokens": 100}}, "[DONE]"))

    prov = OpenAICompatProvider("openai", "https://api.openai.com/v1", lambda: "k", label="OpenAI", transport=httpx.MockTransport(h))
    sv = create_services(proj, provider=prov, config=Config(points_per_usd=30000.0))  # un taux saisi n'a aucun effet hors Poe
    sv.models["m"] = ModelInfo("m", 100_000, 8000, 1e-6, 2e-6, True)
    sv.session.model = "m"
    sv.session.mode = "openai"
    sv.api_id = "openai"
    evs = []
    sv.agent.emit = evs.append
    asyncio.run(sv.agent.run_turn("salut"))
    r = sv.budget.conn.execute("SELECT * FROM ledger").fetchone()
    assert r["tokens_kind"] == "measured" and (r["tokens_in"], r["tokens_out"]) == (1000, 100)
    assert r["points"] is None and r["points_kind"] == "unavailable" and r["usd"] == pytest.approx(1000 * 1e-6 + 100 * 2e-6)


def test_connect_without_keyring_reports_and_stores_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(credentials, "_keyring", lambda: None)
    sv = create_services(tmp_path, config=Config())
    ok, msg = asyncio.run(sv.connect_provider("openai", "sk-a-ne-pas-ecrire"))
    assert not ok and "trousseau" in msg and "OPENAI_API_KEY" in msg
    assert not credentials._legacy_file().exists()
    assert "sk-a-ne-pas-ecrire" not in "".join(p.read_text(errors="ignore") for p in credentials._legacy_file().parent.rglob("*") if p.is_file() and p.suffix in (".json", ".log"))
