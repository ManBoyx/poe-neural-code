import asyncio
import json
import sys
from pathlib import Path

from poe_neural_code.config import Config
from poe_neural_code.mcp_integration.manager import McpManager, ServerConfig, load_mcp_config
from poe_neural_code.tools.base import TodoList, ToolContext
from poe_neural_code.tools.permissions import PermissionManager
from poe_neural_code.tools.workspace import Workspace

SERVER = str(Path(__file__).parent / "data" / "mcp_demo_server.py")


def cfg(**kw):
    return ServerConfig(name="demo", command=sys.executable, args=[SERVER], timeout_s=kw.pop("timeout_s", 20), **kw)


def ctx(tmp_path, asker=None):
    return ToolContext(Workspace(tmp_path), Config(), PermissionManager(asker), TodoList(), asyncio.Event())


def test_discovery_validation_execution_and_confirmation(tmp_path):
    async def go():
        m = McpManager([cfg()])
        await m.start()
        try:
            st = m.status()[0]
            assert st["state"] == "connected" and st["tools"] == 4
            tools = m.tools()
            add = tools["mcp__demo__add"]
            c = ctx(tmp_path)
            assert add.validate({"a": "x", "b": 2})  # validation des arguments (JSON Schema du serveur)
            assert add.validate({"a": 1, "b": 2}) is None
            req = await add.prepare({"a": 1, "b": 2}, c)
            assert req.kind == "mcp" and not await c.permissions.authorize(req)  # confirmation requise, refus par défaut
            asked = []

            async def yes(r):
                asked.append(r)
                return "once"

            c2 = ctx(tmp_path, yes)
            assert await c2.permissions.authorize(req)
            res = await add.run({"a": 20, "b": 22}, c2)
            assert res.ok and "42" in res.output
        finally:
            await m.close()

    asyncio.run(go())


def test_trusted_tool_skips_confirmation(tmp_path):
    async def go():
        m = McpManager([cfg(trusted_tools=["add"])])
        await m.start()
        try:
            t = m.tools()
            assert await t["mcp__demo__add"].prepare({"a": 1, "b": 1}, ctx(tmp_path)) is None
            assert await t["mcp__demo__slow"].prepare({}, ctx(tmp_path)) is not None
        finally:
            await m.close()

    asyncio.run(go())


def test_timeout_is_reported(tmp_path):
    async def go():
        m = McpManager([cfg(timeout_s=1.5)])
        await m.start()
        try:
            r = await m.tools()["mcp__demo__slow"].run({}, ctx(tmp_path))
            assert not r.ok and "délai" in r.output
        finally:
            await m.close()

    asyncio.run(go())


def test_hostile_mcp_response_is_just_data(tmp_path):
    async def go():
        m = McpManager([cfg()])
        await m.start()
        try:
            c = ctx(tmp_path)
            r = await m.tools()["mcp__demo__inject"].run({}, c)
            assert "IGNORE" in r.output  # transmis tel quel comme donnée...
            assert c.permissions.session_grants == set() and not c.permissions.auto_accept_edits  # ...sans rien changer aux permissions
        finally:
            await m.close()

    asyncio.run(go())


def test_disconnection_then_reconnect(tmp_path):
    async def go():
        m = McpManager([cfg(timeout_s=8)])
        await m.start()
        try:
            t = m.tools()
            r = await t["mcp__demo__die"].run({}, ctx(tmp_path))
            assert not r.ok  # erreur propre, pas d'exception
            await asyncio.sleep(0.5)
            assert m.status()[0]["state"] == "error"
            r2 = await t["mcp__demo__add"].run({"a": 1, "b": 2}, ctx(tmp_path))  # reconnexion automatique
            assert r2.ok and "3" in r2.output
        finally:
            await m.close()

    asyncio.run(go())


def test_bad_server_config_does_not_crash():
    async def go():
        m = McpManager([ServerConfig(name="bad", command="/nonexistent/binary", timeout_s=3)])
        await m.start()
        st = m.status()[0]
        assert st["state"] == "error" and st["error"]
        await m.close()

    asyncio.run(go())


def test_load_config_file(tmp_path):
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps({"servers": {"a": {"command": "x", "args": ["1"], "timeout_s": 5, "trusted_tools": ["t"]},
                                         "b": {"url": "http://localhost:1/mcp", "enabled": False}}}))
    cs = load_mcp_config(p)
    assert [c.name for c in cs] == ["a", "b"] and cs[0].trusted_tools == ["t"] and cs[1].enabled is False
    assert load_mcp_config(tmp_path / "none.json") == []
