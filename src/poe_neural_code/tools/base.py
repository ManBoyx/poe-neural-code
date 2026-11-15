"""Contrat des outils : chaque outil prépare (demande d'autorisation éventuelle) puis exécute."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import jsonschema

from ..config import Config
from .permissions import PermissionManager, PermissionRequest
from .workspace import Workspace


@dataclass
class TodoItem:
    id: int
    content: str
    status: str = "pending"  # pending | in_progress | done


class TodoList:
    """Todo list locale : alimentée par l'agent (outil todo_write) ou à la main — aucun appel modèle pour l'afficher."""

    def __init__(self, on_change: Callable[[], None] | None = None):
        self.items: list[TodoItem] = []
        self.on_change = on_change or (lambda: None)

    def replace(self, items: list[dict]) -> None:
        self.items = [TodoItem(i + 1, str(x["content"]), x.get("status", "pending")) for i, x in enumerate(items)]
        self.on_change()

    def add(self, content: str) -> TodoItem:
        it = TodoItem(max([i.id for i in self.items], default=0) + 1, content)
        self.items.append(it)
        self.on_change()
        return it

    def set_status(self, id_: int, status: str) -> bool:
        for i in self.items:
            if i.id == id_:
                i.status = status
                self.on_change()
                return True
        return False

    def clear(self) -> None:
        self.items = []
        self.on_change()

    def progress(self) -> tuple[int, int]:
        return sum(i.status == "done" for i in self.items), len(self.items)

    def to_json(self) -> list[dict]:
        return [{"id": i.id, "content": i.content, "status": i.status} for i in self.items]


@dataclass
class ToolResult:
    ok: bool
    output: str
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolContext:
    workspace: Workspace
    config: Config
    permissions: PermissionManager
    todos: TodoList
    cancel: asyncio.Event
    memory: Any = None  # memory.engine.Memory
    district_id: int | None = None
    conversation_id: int | None = None
    savings: dict = field(default_factory=dict)  # tokens évités (estimation) : partagé avec Session.savings
    cache: Any = None  # memory.cache.WorkingCache
    on_output: Callable[[str], None] | None = None  # sortie de commande en direct


class Tool:
    name: str = ""
    description: str = ""
    schema: dict[str, Any] = {"type": "object", "properties": {}}

    def spec(self) -> dict[str, Any]:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.schema}}

    def validate(self, args: Any) -> str | None:
        try:
            jsonschema.validate(args, self.schema)
        except jsonschema.ValidationError as e:
            return f"arguments invalides pour {self.name} : {e.message}"
        return None

    async def prepare(self, args: dict, ctx: ToolContext) -> PermissionRequest | None:
        return None

    async def run(self, args: dict, ctx: ToolContext) -> ToolResult:
        raise NotImplementedError
