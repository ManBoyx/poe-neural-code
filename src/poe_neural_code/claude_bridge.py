"""Pont MCP local : expose les outils d'Eclipse à Claude Code, dans le processus d'Eclipse.

Claude Code tourne avec ses outils intégrés DÉSACTIVÉS ; il n'agit que via ces outils. Chaque appel traverse donc le gestionnaire
d'autorisations d'Eclipse (aperçu de la commande, diff, confirmation, périmètre du projet, délais, interruption).
Sécurité : écoute 127.0.0.1 sur un port éphémère, jeton secret aléatoire par lancement, aucune exposition réseau.
"""
from __future__ import annotations

import asyncio
import json
import secrets
from typing import Any, Callable

import uvicorn
from mcp import types
from mcp.server.lowlevel import Server

from .provider.base import ToolCall

SERVER_NAME = "eclipse"


class _Auth:
    """Middleware ASGI : refuse toute requête sans le jeton (comparaison à temps constant)."""

    def __init__(self, app, token: str):
        self.app, self.token = app, token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            auth = dict(scope["headers"]).get(b"authorization", b"").decode()
            if not secrets.compare_digest(auth, f"Bearer {self.token}"):
                await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"unauthorized"})
                return
        await self.app(scope, receive, send)


class EclipseBridge:
    def __init__(self, get_agent: Callable[[], Any]):
        self._get_agent = get_agent  # l'Agent Poe sert uniquement d'exécuteur d'outils (sa boucle n'est pas utilisée)
        self.token = secrets.token_urlsafe(32)
        self.url: str | None = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._n = 0

    # --- outils exposés ---------------------------------------------------------
    def _tools(self) -> dict:
        return self._get_agent().tools

    async def _list(self, ctx, params) -> types.ListToolsResult:
        m = self._get_agent().mode
        return types.ListToolsResult(tools=[types.Tool(name=n, description=t.description, input_schema=t.schema)
                                            for n, t in self._tools().items() if m.allows(n)])

    async def _call(self, ctx, params) -> types.CallToolResult:
        agent = self._get_agent()
        self._n += 1
        args = params.arguments or {}
        # _run_tool : validation JSON Schema, aperçu + autorisation, exécution, archivage mémoire, événements UI
        out = await agent._run_tool(ToolCall(f"cc_{self._n}", params.name, json.dumps(args)))
        return types.CallToolResult(content=[types.TextContent(type="text", text=out)], is_error=False)

    # --- cycle de vie -----------------------------------------------------------
    async def start(self) -> str:
        if self.url:
            return self.url
        srv = Server(SERVER_NAME, on_list_tools=self._list, on_call_tool=self._call)
        app = _Auth(srv.streamable_http_app(), self.token)
        cfg = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="on")
        self._server = uvicorn.Server(cfg)
        self._server.install_signal_handlers = lambda: None  # ne pas voler les signaux de Textual
        self._task = asyncio.create_task(self._server.serve())
        for _ in range(100):
            if self._server.started and self._server.servers:
                break
            if self._task.done():
                raise RuntimeError("le pont MCP local n'a pas pu démarrer")
            await asyncio.sleep(0.05)
        port = self._server.servers[0].sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}/mcp"
        return self.url

    def mcp_config(self) -> dict:
        assert self.url
        return {"mcpServers": {SERVER_NAME: {"type": "http", "url": self.url, "headers": {"Authorization": f"Bearer {self.token}"}}}}

    async def stop(self) -> None:
        if self._server:
            self._server.should_exit = True
        if self._task:
            try:
                await asyncio.wait_for(self._task, 5)
            except BaseException:  # noqa: BLE001
                self._task.cancel()
        self.url = None
