"""Plugins Python : ajoutent des outils, des commandes slash et des crochets (hooks).

API (module `.py` avec une fonction `setup(api)`) :
    api.tool(name, description, schema, handler, read_only=False)   # handler(args: dict) -> str   (sync ou async)
    api.command(name, description, handler)                        # handler(args: str) -> str
    api.on("tool_before", fn)   # fn(name, args) -> None | {"deny": "raison"}
    api.on("tool_after", fn)    # fn(name, args, ok, output)
    api.on("turn_start" | "turn_done", fn)   # fn(info: dict)
Emplacements : .eclipse/plugins/ (projet), ~/.config/eclipse/plugins/ (global), <données>/plugins/.

SÉCURITÉ : un plugin est du CODE exécuté avec vos droits (aucune sandbox). Il n'est chargé QU'APRÈS votre approbation explicite
(`/plugins trust NOM`), liée à l'empreinte SHA-256 du fichier : toute modification retire l'approbation. Les outils de plugin passent
par la confirmation d'Eclipse (sauf read_only=True déclaré par le plugin). Un plugin de projet n'est jamais chargé automatiquement.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..logs import get_logger
from ..paths import data_dir
from ..tools.base import Tool, ToolContext, ToolResult
from ..tools.permissions import PermissionRequest

log = get_logger()
EVENTS = ("tool_before", "tool_after", "turn_start", "turn_done")


@dataclass
class PluginInfo:
    name: str
    path: Path
    scope: str
    sha: str
    trusted: bool = False
    loaded: bool = False
    error: str | None = None
    tools: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)


class PluginTool(Tool):
    def __init__(self, plugin: str, name: str, description: str, schema: dict, handler: Callable, read_only: bool):
        self.plugin, self.handler, self.read_only = plugin, handler, read_only
        self.name = f"{plugin}_{name}"[:64]
        self.description = f"[plugin {plugin}] {description}"
        self.schema = schema or {"type": "object", "properties": {}}

    async def prepare(self, args, ctx: ToolContext):
        if self.read_only:
            return None
        return PermissionRequest(self.name, "plugin", f"Outil du plugin « {self.plugin} » : {self.name}", json.dumps(args, ensure_ascii=False, indent=2),
                                 grant_key=f"plugin:{self.name}", warnings=["code de plugin : exécuté avec vos droits, sans sandbox"])

    async def run(self, args, ctx: ToolContext):
        try:
            out = self.handler(args)
            if asyncio.iscoroutine(out):
                out = await out
            return ToolResult(True, str(out)[:20_000])
        except Exception as e:  # noqa: BLE001
            return ToolResult(False, f"erreur du plugin {self.plugin} : {e.__class__.__name__}: {e}")


class _API:
    def __init__(self, reg: "PluginRegistry", info: PluginInfo):
        self._reg, self._info = reg, info

    def tool(self, name: str, description: str, schema: dict, handler: Callable, read_only: bool = False) -> None:
        t = PluginTool(self._info.name, name, description, schema, handler, read_only)
        self._reg.tools[t.name] = t
        self._info.tools.append(t.name)

    def command(self, name: str, description: str, handler: Callable) -> None:
        self._reg.commands[name] = (self._info.name, description, handler)
        self._info.commands.append(name)

    def on(self, event: str, fn: Callable) -> None:
        if event not in EVENTS:
            raise ValueError(f"événement inconnu : {event} ({', '.join(EVENTS)})")
        self._reg.hooks.setdefault(event, []).append((self._info.name, fn))


class PluginRegistry:
    def __init__(self, trust_file: Path | None = None):
        self.trust_file = trust_file or data_dir() / "plugins_trust.json"
        self.plugins: dict[str, PluginInfo] = {}
        self.tools: dict[str, Tool] = {}
        self.commands: dict[str, tuple[str, str, Callable]] = {}
        self.hooks: dict[str, list[tuple[str, Callable]]] = {}

    # --- confiance (liée à l'empreinte du fichier) ---
    def _trust(self) -> dict[str, str]:
        try:
            return json.loads(self.trust_file.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def discover(self, root: Path, home: Path | None = None) -> None:
        home = home or Path.home()
        self.plugins.clear()
        trust = self._trust()
        dirs = [(root / ".eclipse" / "plugins", "project"), (home / ".config" / "eclipse" / "plugins", "global"), (data_dir() / "plugins", "global")]
        for base, scope in dirs:
            if not base.is_dir():
                continue
            for f in sorted(base.glob("*.py")):
                if f.stem in self.plugins:
                    continue
                sha = hashlib.sha256(f.read_bytes()).hexdigest()
                self.plugins[f.stem] = PluginInfo(f.stem, f, scope, sha, trusted=trust.get(str(f)) == sha)

    def trust(self, name: str) -> bool:
        p = self.plugins.get(name)
        if not p:
            return False
        trust = self._trust()
        trust[str(p.path)] = p.sha
        self.trust_file.write_text(json.dumps(trust, indent=2), encoding="utf-8")
        p.trusted = True
        return True

    def untrust(self, name: str) -> bool:
        p = self.plugins.get(name)
        if not p:
            return False
        trust = self._trust()
        trust.pop(str(p.path), None)
        self.trust_file.write_text(json.dumps(trust, indent=2), encoding="utf-8")
        p.trusted = False
        return True

    def load_trusted(self) -> None:
        self.tools.clear(); self.commands.clear(); self.hooks.clear()
        for info in self.plugins.values():
            info.loaded, info.error, info.tools, info.commands = False, None, [], []
            if not info.trusted:
                continue
            try:
                spec = importlib.util.spec_from_file_location(f"eclipse_plugin_{info.name}", info.path)
                mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                mod.setup(_API(self, info))
                info.loaded = True
            except Exception as e:  # noqa: BLE001 — un plugin défaillant ne casse pas Eclipse
                info.error = f"{e.__class__.__name__}: {e}"
                log.error("plugin %s : %s", info.name, e)

    # --- crochets ---
    async def fire(self, event: str, *args: Any) -> list[Any]:
        out = []
        for pname, fn in self.hooks.get(event, []):
            try:
                r = fn(*args)
                if asyncio.iscoroutine(r):
                    r = await r
                out.append((pname, r))
            except Exception as e:  # noqa: BLE001
                log.error("hook %s/%s : %s", pname, event, e)
        return out

    async def before_tool(self, name: str, args: dict) -> tuple[str, str] | None:
        for pname, r in await self.fire("tool_before", name, args):
            if isinstance(r, dict) and r.get("deny"):
                return pname, str(r["deny"])
        return None
