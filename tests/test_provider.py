import asyncio
import json

import httpx
import pytest

from poe_neural_code.provider.base import Done, NotConfigured, ProviderError, TextDelta, ToolCall, Usage
from poe_neural_code.provider.poe import PoeProvider


def sse(*datas):
    return "".join(f"data: {json.dumps(d) if not isinstance(d, str) else d}\n\n" for d in datas)


async def collect(p, **kw):
    return [e async for e in p.stream("m", [{"role": "user", "content": "x"}], kw.get("tools"), 100)]


def prov(handler):
    return PoeProvider(transport=httpx.MockTransport(handler))


def test_not_configured_is_explicit(monkeypatch):
    p = PoeProvider(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    assert not p.configured()
    with pytest.raises(NotConfigured) as e:
        asyncio.run(collect(p))
    assert "POE_API_KEY" in str(e.value) and "simulée" in str(e.value)


def test_stream_text_tool_calls_and_usage(monkeypatch):
    monkeypatch.setenv("POE_API_KEY", "k")
    seen = {}

    def h(req):
        seen["auth"], seen["body"] = req.headers["authorization"], json.loads(req.content)
        return httpx.Response(200, text=sse(
            {"choices": [{"delta": {"content": "Sal"}}]}, {"choices": [{"delta": {"content": "ut"}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c9", "function": {"name": "read_file", "arguments": '{"pa'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'th": "a"}'}}]}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 4}}, "[DONE]"))

    ev = asyncio.run(collect(prov(h), tools=[{"type": "function"}]))
    assert "".join(e.text for e in ev if isinstance(e, TextDelta)) == "Salut"
    tcs = [e for e in ev if isinstance(e, ToolCall)]
    assert tcs[0].id == "c9" and json.loads(tcs[0].arguments) == {"path": "a"}
    assert [e for e in ev if isinstance(e, Usage)][0].prompt_tokens == 12
    assert isinstance(ev[-1], Done) and ev[-1].finish_reason == "tool_calls"
    assert seen["auth"] == "Bearer k" and seen["body"]["stream"] and seen["body"]["tools"] and seen["body"]["max_tokens"] == 100


def test_retry_without_stream_options_on_400(monkeypatch):
    monkeypatch.setenv("POE_API_KEY", "k")
    bodies = []

    def h(req):
        b = json.loads(req.content)
        bodies.append(b)
        if "stream_options" in b:
            return httpx.Response(400, json={"error": {"message": "unknown field"}})
        return httpx.Response(200, text=sse({"choices": [{"delta": {"content": "ok"}}]}, "[DONE]"))

    ev = asyncio.run(collect(prov(h)))
    assert len(bodies) == 2 and any(isinstance(e, TextDelta) for e in ev) and not any(isinstance(e, Usage) for e in ev)


@pytest.mark.parametrize("status,word", [(401, "clé"), (402, "crédits"), (429, "débit"), (413, "contexte")])
def test_http_errors_are_explicit(monkeypatch, status, word):
    monkeypatch.setenv("POE_API_KEY", "k")
    p = prov(lambda r: httpx.Response(status, json={"error": {"message": "m"}}))
    with pytest.raises(ProviderError) as e:
        asyncio.run(collect(p))
    assert e.value.status == status and word in str(e.value)


def test_network_error_is_retryable(monkeypatch):
    monkeypatch.setenv("POE_API_KEY", "k")

    def h(req):
        raise httpx.ConnectError("down")

    with pytest.raises(ProviderError) as e:
        asyncio.run(collect(prov(h)))
    assert e.value.retryable


def test_list_models_parses_pricing_and_tools():
    data = {"data": [{"id": "a", "architecture": {"output_modalities": ["text"]}, "supported_endpoints": ["/v1/chat/completions"],
                      "supported_features": ["tools"], "pricing": {"prompt": "0.000001", "completion": "0.000003"},
                      "context_window": {"context_length": 1000, "max_output_tokens": 100}},
                     {"id": "b", "architecture": {"output_modalities": ["video"]}, "pricing": None}]}
    p = prov(lambda r: httpx.Response(200, json=data))
    ms = {m.id: m for m in asyncio.run(p.list_models())}
    assert ms["a"].supports_tools and ms["a"].chat_text and ms["a"].prompt_price == 1e-6 and ms["a"].max_output == 100
    assert not ms["b"].chat_text and ms["b"].prompt_price is None
