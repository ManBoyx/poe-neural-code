"""Intégration MCP (SDK officiel `mcp`) : stdio ou URL (HTTP streamable), selon la configuration.

Chaque serveur vit dans une tâche dédiée qui possède sa connexion (contrainte des scopes anyio) ; les appels passent par
une file. Erreurs, délais et déconnexions sont capturés : l'état du serveur passe à « error » et un nouvel appel tente de
se reconnecter une fois. Les réponses MCP sont des DONNÉES non fiables et n'accordent jamais de permission.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..paths import data_dir
from ..tools.base import Tool, ToolContext, ToolResult
from ..tools.permissions import PermissionRequest


@dataclass
class ServerConfig:
    name: str
    command: str | None = None
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    url: str | None = None
    timeout_s: float = 30.0
    trusted_tools: list[str] = field(default_factory=list)  # appels sans confirmation (explicite, par l'utilisateur)
    enabled: bool = True


def load_mcp_config(path: str | Path | None = None) -> list[ServerConfig]:
    p = Path(path) if path else data_dir() / "mcp.json"
    if not p.exists():
        return []
    raw = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for name, c in (raw.get("servers") or {}).items():
        out.append(ServerConfig(name=name, command=c.get("command"), args=c.get("args", []), env=c.get("env", {}), url=c.get("url"),
                                timeout_s=float(c.get("timeout_s", 30)), trusted_tools=c.get("trusted_tools", []),
                                enabled=c.get("enabled", True)))
    return out


class McpServer:
    def __init__(self, cfg: ServerConfig):
        self.cfg = cfg
        self.state = "disconnected"  # disconnected | connecting | connected | error | disabled
        self.error: str | None = None
        self.tools: list[Any] = []
        self._queue: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._ready: asyncio.Future | None = None

    def _target(self):
        from mcp import StdioServerParameters
        if self.cfg.command:
            import os
            env = {**os.environ, **self.cfg.env} if self.cfg.env else None
            return StdioServerParameters(command=self.cfg.command, args=self.cfg.args, env=env)
        if self.cfg.url:
            return self.cfg.url
        raise ValueError("configuration MCP : 'command' ou 'url' requis")

    async def _runner(self, ready: asyncio.Future) -> None:
        from mcp import Client
        try:
            async with Client(self._target()) as client:
                res = await asyncio.wait_for(client.list_tools(), self.cfg.timeout_s)
                self.tools = list(res.tools)
                self.state, self.error = "connected", None
                ready.set_result(True)
                while True:
                    item = await self._queue.get()
                    if item is None:
                        return
                    name, args, fut = item
                    try:
                        r = await asyncio.wait_for(client.call_tool(name, args), self.cfg.timeout_s)
                        fut.set_result(r)
                    except Exception as e:  # noqa: BLE001 — remonté à l'appelant
                        fut.set_exception(e)
                        if not isinstance(e, asyncio.TimeoutError):
                            raise
        except BaseException as e:  # noqa: BLE001
            self.state, self.error = "error", f"{e.__class__.__name__}: {e}"[:300]
            if not ready.done():
                ready.set_exception(RuntimeError(self.error))
            while not self._queue.empty():
                it = self._queue.get_nowait()
                if it and not it[2].done():
                    it[2].set_exception(RuntimeError("serveur MCP déconnecté"))
            if isinstance(e, asyncio.CancelledError):
                raise

    async def connect(self) -> None:
        if not self.cfg.enabled:
            self.state = "disabled"
            return
        if self._task and not self._task.done():
            return
        self.state = "connecting"
        self._queue = asyncio.Queue()
        ready: asyncio.Future = asyncio.get_running_loop().create_future()
        self._task = asyncio.create_task(self._runner(ready))
        try:
            await asyncio.wait_for(asyncio.shield(ready), self.cfg.timeout_s + 5)
        except Exception as e:  # noqa: BLE001
            self.state, self.error = "error", self.error or f"{e.__class__.__name__}: {e}"[:300]
            self._task.cancel()

    async def call(self, tool: str, args: dict) -> Any:
        if self.state != "connected" or not self._task or self._task.done():
            await self.connect()  # une tentative de reconnexion
        if self.state != "connected":
            raise RuntimeError(f"serveur MCP « {self.cfg.name} » indisponible : {self.error}")
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self._queue.put((tool, args, fut))
        return await fut

    async def close(self) -> None:
        if self._task and not self._task.done():
            await self._queue.put(None)
            try:
                await asyncio.wait_for(self._task, 5)
            except BaseException:  # noqa: BLE001
                self._task.cancel()
        self.state = "disconnected"


def _flatten(result: Any) -> tuple[bool, str]:
    parts = []
    for b in getattr(result, "content", None) or []:
        t = getattr(b, "text", None)
        parts.append(t if t is not None else f"[contenu {getattr(b, 'type', 'inconnu')} non affiché]")
    sc = getattr(result, "structured_content", None) or getattr(result, "structuredContent", None)
    if sc and not parts:
        parts.append(json.dumps(sc, ensure_ascii=False))
    return not getattr(result, "is_error", getattr(result, "isError", False)), "\n".join(parts) or "(réponse vide)"


class McpTool(Tool):
    def __init__(self, server: McpServer, tool: Any):
        self.server, self.raw = server, tool
        self.name = f"mcp__{server.cfg.name}__{tool.name}"[:64]
        self.description = f"[MCP {server.cfg.name}] {tool.description or tool.name}"
        schema = getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None) or {"type": "object", "properties": {}}
        self.schema = schema if schema.get("type") == "object" else {"type": "object", "properties": {}}

    async def prepare(self, args, ctx: ToolContext):
        if self.raw.name in self.server.cfg.trusted_tools:
            return None
        ann = getattr(self.raw, "annotations", None)
        destructive = bool(getattr(ann, "destructive_hint", None) or getattr(ann, "destructiveHint", None))
        return PermissionRequest(self.name, "mcp", f"Appel MCP {self.server.cfg.name}/{self.raw.name}", json.dumps(args, ensure_ascii=False, indent=2),
                                 destructive=destructive, grant_key=f"mcp:{self.server.cfg.name}:{self.raw.name}",
                                 warnings=["outil externe : ses effets ne sont pas contrôlés par cette application"])

    async def run(self, args, ctx: ToolContext):
        try:
            res = await self.server.call(self.raw.name, args)
        except asyncio.TimeoutError:
            return ToolResult(False, f"délai dépassé ({self.server.cfg.timeout_s}s) pour {self.name}")
        except Exception as e:  # noqa: BLE001
            return ToolResult(False, f"erreur MCP : {e}")
        ok, text = _flatten(res)
        return ToolResult(ok, text[:20_000])


class McpManager:
    def __init__(self, configs: list[ServerConfig]):
        self.servers = {c.name: McpServer(c) for c in configs}

    async def start(self) -> None:
        await asyncio.gather(*(s.connect() for s in self.servers.values()), return_exceptions=True)

    def tools(self) -> dict[str, Tool]:
        out: dict[str, Tool] = {}
        for s in self.servers.values():
            if s.state == "connected":
                for t in s.tools:
                    mt = McpTool(s, t)
                    out[mt.name] = mt
        return out

    def status(self) -> list[dict]:
        return [{"name": n, "state": s.state, "tools": len(s.tools), "error": s.error} for n, s in self.servers.items()]

    async def close(self) -> None:
        await asyncio.gather(*(s.close() for s in self.servers.values()), return_exceptions=True)
