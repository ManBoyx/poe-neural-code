"""Exécution de commandes : délai, annulation, arbre de processus tué, sortie bornée, clé API non transmise.

AUCUNE isolation (pas de sandbox, pas de conteneur) : la commande s'exécute avec les droits de l'utilisateur ;
seuls la confirmation, le dossier de travail, le délai et l'absence d'élévation de privilèges encadrent l'exécution.
"""
from __future__ import annotations

import asyncio
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

from .. import platform_compat as PC
from .base import Tool, ToolContext, ToolResult
from .permissions import AdminRefused, PermissionRequest, check_command

MAX_OUT = 20_000
SECRET_ENV = ("POE_API_KEY",)


def _outside_paths(cmd: str, ctx: ToolContext) -> list[str]:
    """Heuristique : chemins absolus / ~ / .. cités dans la commande qui sortent du projet."""
    out = []
    for tok in re.findall(r"""(?:(?<=\s)|^)(~[^\s'"]*|/[^\s'"]*|\.\./[^\s'"]*|[A-Za-z]:\\[^\s'"]*)""", cmd):
        if tok in ("/", "/dev/null"):
            continue
        _, inside = ctx.workspace.resolve(tok)
        if not inside:
            out.append(tok)
    return out


async def kill_tree(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        if PC.is_windows():
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
        else:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except asyncio.TimeoutError:
                os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


class RunCommand(Tool):
    name = "run_command"
    description = ("Exécute une commande dans la racine du projet (scripts, tests, builds), avec le shell indiqué dans le prompt système. Délai par défaut 120 s. "
                   "Confirmation demandée. Pas de sudo.")
    schema = {"type": "object", "properties": {"command": {"type": "string", "minLength": 1},
                                               "timeout_s": {"type": "integer", "minimum": 1, "maximum": 3600}},
              "required": ["command"], "additionalProperties": False}

    async def prepare(self, args, ctx):
        destructive, warns = check_command(args["command"])  # peut lever AdminRefused
        outside = _outside_paths(args["command"], ctx)
        if outside:
            warns.append("chemins hors du projet détectés : " + ", ".join(outside[:3]))
        return PermissionRequest(self.name, "exec", "Exécuter une commande", args["command"], destructive=destructive,
                                 outside=bool(outside), grant_key="exec:" + args["command"], warnings=warns)

    async def run(self, args, ctx):
        cmd = args["command"]
        timeout = args.get("timeout_s") or ctx.config.command_timeout_s
        env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
        env.setdefault("PYTHONIOENCODING", "utf-8")
        spec = PC.pick_shell(getattr(ctx.config, "shell", "auto"))
        argv, line = PC.shell_invocation(cmd, spec)
        common = dict(cwd=str(ctx.workspace.root), env=env, stdin=asyncio.subprocess.DEVNULL,
                      stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, **PC.group_kwargs())
        if argv is not None:
            proc = await asyncio.create_subprocess_exec(*argv, **common)
        else:  # cmd.exe : la ligne est passée telle quelle au shell système
            proc = await asyncio.create_subprocess_shell(line, **common)
        chunks: list[bytes] = []
        size = 0

        async def pump():
            nonlocal size
            assert proc.stdout
            while True:
                b = await proc.stdout.read(4096)
                if not b:
                    return
                if size < MAX_OUT:
                    chunks.append(b)
                    size += len(b)
                    if ctx.on_output:
                        ctx.on_output(b.decode("utf-8", errors="replace"))

        pump_t = asyncio.create_task(pump())
        wait_t = asyncio.create_task(proc.wait())
        cancel_t = asyncio.create_task(ctx.cancel.wait())
        done, _ = await asyncio.wait({wait_t, cancel_t}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        status = None
        if wait_t not in done:
            status = "interrompu par l'utilisateur" if ctx.cancel.is_set() else f"délai de {timeout}s dépassé"
            await kill_tree(proc)
            await asyncio.wait({wait_t}, timeout=5)
        cancel_t.cancel()
        try:
            await asyncio.wait_for(pump_t, 2)
        except asyncio.TimeoutError:
            pump_t.cancel()
        text = b"".join(chunks).decode("utf-8", errors="replace")
        if size >= MAX_OUT:
            text += "\n[… sortie tronquée]"
        if status:
            return ToolResult(False, f"{text}\n[{status}]", {"killed": True, "reason": status})
        rc = proc.returncode
        return ToolResult(rc == 0, f"{text}\n[code de sortie : {rc}]", {"returncode": rc})
