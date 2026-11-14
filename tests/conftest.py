import asyncio

import pytest

from poe_neural_code.budget import Budget
from poe_neural_code.config import Config
from poe_neural_code.memory.engine import Memory
from poe_neural_code.provider.base import Capabilities, Done, ModelInfo, TextDelta, ToolCall, Usage


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("PNC_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("POE_API_KEY", raising=False)


class Clock:
    def __init__(self, t=1_700_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def budget(tmp_path, clock):
    b = Budget(tmp_path / "b.db", clock=clock)
    yield b
    b.close()


@pytest.fixture
def mem(tmp_path):
    m = Memory(tmp_path / "m.db")
    yield m
    m.close()


class FakeProvider:
    """DOUBLE DE TEST scripté (jamais utilisé par l'application) : rejoue des tours prédéfinis."""
    name = "fake"
    capabilities = Capabilities()

    def __init__(self, turns, usage=(100, 20), configured=True):
        self.turns = list(turns)
        self.calls = []
        self.usage = usage
        self._configured = configured
        self.delay = 0.0

    def configured(self):
        return self._configured

    async def list_models(self):
        return [MODEL]

    async def aclose(self):
        pass

    async def stream(self, model, messages, tools, max_tokens, options=None):
        self.calls.append({"model": model, "messages": messages, "tools": tools, "max_tokens": max_tokens, "options": options})
        turn = self.turns.pop(0) if self.turns else [TextDelta("(fin)")]
        for ev in turn:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield ev
        if self.usage:
            yield Usage(*self.usage)
        yield Done("stop")


def tc(name, args, id_="c1"):
    import json
    return ToolCall(id_, name, json.dumps(args))


MODEL = ModelInfo("m1", context_length=100_000, max_output=8000, prompt_price=1e-6, completion_price=3e-6, supports_tools=True)


class FakeKeyring:
    """Trousseau en mémoire : les tests n'écrivent JAMAIS dans le trousseau réel de l'utilisateur."""

    def __init__(self):
        self.store = {}

    def get_password(self, service, user):
        return self.store.get((service, user))

    def set_password(self, service, user, pw):
        self.store[(service, user)] = pw

    def delete_password(self, service, user):
        if (service, user) not in self.store:
            raise KeyError(user)
        del self.store[(service, user)]

    def get_keyring(self):
        return self


@pytest.fixture(autouse=True)
def fake_keyring(monkeypatch):
    from poe_neural_code import credentials
    kr = FakeKeyring()
    monkeypatch.setattr(credentials, "_keyring", lambda: kr)
    return kr
