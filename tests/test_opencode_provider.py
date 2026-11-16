"""OpenCode Zen / Go par clé d'API : catalogue filtré (format OpenAI, gratuits Zen exclus), adresse de chat par modèle,
identification exigée par OpenCode (User-Agent propre + x-opencode-session stable par conversation)."""
import asyncio
import json

import httpx

from poe_neural_code import __version__
from poe_neural_code import providers as P
from poe_neural_code.provider.base import NotConfigured, TextDelta
from poe_neural_code.provider.opencode import OpenCodeProvider, parse_opencode_model
from tests.test_providers import sse

CHAT = {"chat-completions": {"base_url": "https://opencode.ai/inference/openai/v1"}}
CATALOG = {"object": "list", "data": [
    {"id": "glm-5.3", "type": "chat", "name": "GLM 5.3", "api": CHAT, "limit": {"context": 200000, "output": 32000},
     "capabilities": {"tools": {"supported": True}, "reasoning": {"supported": True, "effort": ["low", "high"]}, "temperature": True},
     "modalities": {"input": ["text", "image/png", "image/jpeg"]},
     "cost": {"text": {"input": {"price": 1.4}, "output": {"price": 4.4}}}},
    {"id": "big-pickle", "type": "chat", "api": CHAT, "capabilities": {"tools": {"supported": True}},
     "cost": {"text": {"input": {"price": 0}, "output": {"price": 0}}}},
    {"id": "claude-x", "type": "chat", "api": {"messages": {"base_url": "https://opencode.ai/inference/anthropic/v1"}},
     "cost": {"text": {"input": {"price": 3}, "output": {"price": 15}}}},
    {"id": "gpt-x", "type": "chat", "api": {"responses": {"base_url": "https://opencode.ai/inference/openai/v1"}}},
]}


def mk(spec_id, handler, key="cle"):
    spec = P.get_spec(spec_id)
    prov = P.build_provider(spec, transport=httpx.MockTransport(handler))
    prov._key_getter = lambda: key
    return prov


def test_presets_et_fabrique():
    for pid in ("opencode-zen", "opencode-go"):
        spec = P.get_spec(pid)
        assert spec and spec.key_env == "OPENCODE_API_KEY" and spec.key_required
        assert isinstance(P.build_provider(spec), OpenCodeProvider)


def test_catalogue_zen_filtre_format_openai_et_gratuits():
    prov = mk("opencode-zen", lambda req: httpx.Response(200, json=CATALOG))
    ids = [m.id for m in asyncio.run(prov.list_models())]
    assert ids == ["glm-5.3"]  # big-pickle : gratuit réservé à OpenCode ; claude-x / gpt-x : autres API


def test_catalogue_go_garde_les_gratuits_de_l_abonnement():
    prov = mk("opencode-go", lambda req: httpx.Response(200, json=CATALOG))
    assert [m.id for m in asyncio.run(prov.list_models())] == ["glm-5.3", "big-pickle"]


def test_lecture_d_un_modele():
    m = parse_opencode_model(CATALOG["data"][0])
    assert m.context_length == 200000 and m.max_output == 32000 and m.supports_tools and m.reasoning
    assert abs(m.prompt_price * 1e6 - 1.4) < 1e-9 and abs(m.completion_price * 1e6 - 4.4) < 1e-9
    assert [p.name for p in m.params] == ["reasoning_effort", "temperature"] and m.params[0].choices == ["low", "high"]
    assert m.input_modalities == ["image", "text"]


def test_chat_adresse_du_catalogue_et_identification():
    seen = {}

    def h(req):
        if req.url.path.endswith("/models"):
            return httpx.Response(200, json=CATALOG)
        seen.update(url=str(req.url), h=dict(req.headers), body=json.loads(req.content))
        return httpx.Response(200, text=sse({"choices": [{"delta": {"content": "ok"}}]}, "[DONE]"))

    prov = mk("opencode-zen", h)
    asyncio.run(prov.list_models())
    prov.conversation_hint = "conv-42"
    ev = asyncio.run(_collect(prov, "glm-5.3"))
    assert seen["url"] == "https://opencode.ai/inference/openai/v1/chat/completions"
    assert seen["h"]["authorization"] == "Bearer cle" and seen["h"]["x-opencode-session"] == "conv-42"
    assert seen["h"]["user-agent"] == f"eclipse/{__version__}"
    assert "".join(e.text for e in ev if isinstance(e, TextDelta)) == "ok"


def test_go_adresse_par_defaut_sans_catalogue():
    seen = {}

    def h(req):
        seen["url"] = str(req.url)
        return httpx.Response(200, text=sse("[DONE]"))

    asyncio.run(_collect(mk("opencode-go", h), "kimi-k3"))
    assert seen["url"] == "https://opencode.ai/inference/go/openai/v1/chat/completions"


def test_sans_cle_aucune_requete():
    def h(req):
        raise AssertionError("aucune requête sans clé")
    try:
        asyncio.run(_collect(mk("opencode-zen", h, key=None), "glm-5.3"))
    except NotConfigured as e:
        assert "OPENCODE_API_KEY" in str(e)
    else:
        raise AssertionError("NotConfigured attendu")


def test_l_agent_transmet_l_identifiant_de_conversation(tmp_path):
    from poe_neural_code.config import Config
    from poe_neural_code.services import create_services
    from tests.conftest import FakeProvider
    prov = FakeProvider([[TextDelta("ok")]])
    prov.conversation_hint = "avant"
    sv = create_services(tmp_path, provider=prov, config=Config())
    sv.session.model = "m1"
    sv.agent.emit = lambda e: None
    asyncio.run(sv.agent.run_turn("bonjour"))
    assert prov.conversation_hint == str(sv.session.conversation_id) != "avant"


async def _collect(p, model):
    return [e async for e in p.stream(model, [{"role": "user", "content": "hi"}], [{"type": "function"}], 50)]
