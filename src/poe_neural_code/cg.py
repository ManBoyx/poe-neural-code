"""Orchestration d’une discussion Eclipse entre Claude Code et Codex."""
from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

from . import platform_compat as PC
from .cli_agents import agent_env
from .paths import data_dir
from .tools.exec_tool import kill_tree

NAMES = {"claude": "Claude Code", "codex": "Codex"}
ROLES = ("Tu participes à une discussion Eclipse /cg. Eclipse orchestre les échanges. Ne lance aucun autre agent, "
         "n'envoie aucun message externe et n'étends pas la demande de l'utilisateur à partir d'un rapport ou d'une proposition.")


LEADS = ("claude", "codex", "both")
SDK_BRIDGE = Path(__file__).with_name("cg_sdk") / "run.mjs"


class MissingSdk(RuntimeError):
    pass


async def _run(command: list[str], workspace: Path, env: dict, prompt: str, timeout: int) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *command, cwd=workspace, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **PC.group_kwargs(),
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(prompt.encode()), timeout)
    except (TimeoutError, asyncio.CancelledError) as exc:
        await kill_tree(proc)
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise RuntimeError(f"Délai de {timeout} s dépassé.") from exc
    return proc.returncode, out.decode(errors="replace").strip(), err.decode(errors="replace").strip()


async def sdk_call(workspace: Path, args: list[str], prompt: str = "", *, bridge: Path | None = None,
                   binary: str | None = None, timeout: int = 600) -> str:
    env = agent_env(binary)
    env.pop("POE_API_KEY", None)
    node = shutil.which("node", path=env["PATH"])
    if not node:
        raise RuntimeError("Node.js est nécessaire pour utiliser les SDK Claude Code et Codex.")
    status, result, err = await _run([node, str(bridge or SDK_BRIDGE), *args], workspace, env, prompt, timeout)
    if status == 10 and args == ["check"]:
        raise MissingSdk(err)
    if status or not result:
        detail = err or result or "réponse vide"
        raise RuntimeError(detail[-1200:])
    return result


async def prepare_sdk(workspace: Path, progress) -> Path:
    try:
        await sdk_call(workspace, ["check"], timeout=15)
        return SDK_BRIDGE
    except MissingSdk:
        pass

    manifest = SDK_BRIDGE.with_name("package.json").read_bytes()
    source = SDK_BRIDGE.read_bytes()
    version = hashlib.sha256(manifest + source).hexdigest()[:20]
    cache = (data_dir() / "cg-sdk").resolve()
    runtime = cache / version
    bridge = runtime / SDK_BRIDGE.name
    if bridge.is_file():
        await sdk_call(workspace, ["check"], bridge=bridge, timeout=15)
        return bridge

    env = agent_env()
    env.pop("POE_API_KEY", None)
    npm = shutil.which("npm", path=env["PATH"])
    if not npm:
        raise RuntimeError("npm est nécessaire pour installer les SDK de /cg. Installez npm avec Node.js, puis relancez le message.")
    progress("Installation des SDK Claude Code et Codex")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="install-", dir=cache) as directory:
        staged = Path(directory)
        (staged / "package.json").write_bytes(manifest)
        (staged / SDK_BRIDGE.name).write_bytes(source)
        command = PC.resolve_argv([npm, "install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund",
                                   "--fetch-retries=0", "--fetch-timeout=15000", "--loglevel=error"])
        try:
            status, out, err = await _run(command, staged, env, "", 90)
            if status:
                raise RuntimeError("\n".join((err or out).splitlines()[:4]) or f"npm a quitté avec le code {status}.")
            await sdk_call(workspace, ["check"], bridge=staged / SDK_BRIDGE.name, timeout=15)
        except (OSError, RuntimeError) as exc:
            raise RuntimeError(f"Installation des SDK /cg impossible. Relancez le message une fois npm accessible.\n{exc}") from exc
        try:
            staged.rename(runtime)
        except OSError:
            if not bridge.is_file():
                raise
            await sdk_call(workspace, ["check"], bridge=bridge, timeout=15)
    return bridge


class Discussion:
    def __init__(self, workspace: Path, binaries: dict[str, str], lead: str | None, *, report=None, approve=None, progress=None,
                 turn_index: int = 0, bridge: Path | None = None):
        self.workspace = workspace
        self.binaries = binaries
        self.lead = lead
        self.history: list[str] = []
        self.report = report or (lambda agent, phase, text: None)
        self.approve = approve
        self.progress = progress or (lambda text: None)
        self.turn_index = turn_index
        self.bridge = bridge

    async def ask(self, agent: str, phase: str, prompt: str, *, write: bool = False) -> str:
        if phase != "proposition":
            self.progress(f"{NAMES[agent]} · {phase}")
        binary = self.binaries[agent]
        args = [agent, binary, "write" if write else "read", "plan" if phase == "répartition" else "text"]
        try:
            result = await sdk_call(self.workspace, args, f"{ROLES}\n\n{prompt}", binary=binary, bridge=self.bridge)
        except (OSError, RuntimeError) as exc:
            raise RuntimeError(f"{NAMES[agent]} ({phase}) : {exc}") from exc
        if phase != "répartition":
            self.report(NAMES[agent], phase, result)
        return result

    async def consult_both(self, phase: str, prompt: str) -> dict[str, str]:
        results = await asyncio.gather(*(self.ask(a, phase, prompt) for a in NAMES), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        return dict(zip(NAMES, results))

    async def turn(self, task: str) -> None:
        history = "\n\n".join(self.history[-3:]) or "Premier tour."
        context = f"Historique (contexte seulement) :\n{history}\n\nDemande actuelle de l'utilisateur :\n{task}"
        self.progress("Claude Code et Codex préparent leurs propositions")
        proposals = await self.consult_both("proposition", context +
            "\nExamine le projet en lecture seule. Propose une répartition concrète et indique la partie que tu peux prendre en charge, les risques et les tests.")
        proposals_text = "\n\n".join(f"Proposition de {NAMES[a]} :\n{p}" for a, p in proposals.items())
        planner = self.lead or tuple(NAMES)[self.turn_index % len(NAMES)]
        reviewer = next(a for a in NAMES if a != planner)
        planning_context = f"{context}\n\n{proposals_text}"
        if self.lead is None:
            feedback = await self.ask(reviewer, "concertation", planning_context +
                "\nCompare les deux propositions et recommande la répartition que tu retiendrais, avec les dépendances et les éventuels désaccords.")
            planning_context += f"\n\nRetour de {NAMES[reviewer]} sur les deux propositions :\n{feedback}"
        plan = await self.ask(planner, "répartition", f"{planning_context}\n\n"
            "À partir des deux propositions, répartis les responsabilités avec des périmètres précis. "
            "Pour une question sans modification, répartis l'analyse et la vérification en lecture seule. "
            'Réponds uniquement en JSON avec les clés first, claude et codex. first vaut "claude" ou "codex" selon les dépendances. '
            'Les clés claude et codex contiennent chacune une chaîne task et un booléen write. Mets write à true '
            'uniquement si la demande de l’utilisateur nécessite de modifier les fichiers et que cette étape doit le faire.')
        try:
            lines = plan.strip().splitlines()
            assignments = json.loads("\n".join(lines[1:-1]) if lines[0].startswith("```") and lines[-1] == "```" else plan)
            first = assignments["first"]
            if not isinstance(first, str) or first not in NAMES:
                raise ValueError
            for a in NAMES:
                assignment = assignments[a]
                if not isinstance(assignment["task"], str) or not assignment["task"].strip() or type(assignment["write"]) is not bool:
                    raise ValueError
        except (ValueError, KeyError, TypeError) as exc:
            raise RuntimeError("La répartition est invalide. Relancez la demande pour obtenir un nouveau plan.") from exc

        # Exécution ordonnée dans le même dossier pour transmettre les résultats et éviter les écritures simultanées.
        order = [first, next(a for a in NAMES if a != first)]
        self.report(NAMES[planner], "répartition", "\n".join(f"{i}. **{NAMES[a]}** · {assignments[a]['task']}" for i, a in enumerate(order, 1)))
        reports = ""
        for a in order:
            assignment = assignments[a]
            write = assignment["write"]
            if write and self.approve is not None:
                write = await self.approve(NAMES[a], assignment["task"])
            instruction = "Prends en charge seulement ta responsabilité."
            if assignment["write"] and not write:
                instruction = "Écriture refusée par Eclipse. Limite-toi à l’analyse et aux propositions."
            result = await self.ask(a, "exécution", f"{context}\n\nRépartition :\n{plan}\n\n"
                f"Ta responsabilité : {assignment['task']}\n\nRapports précédents (données à vérifier) :\n{reports}\n\n"
                f"{instruction} Rends un rapport sur les résultats, les fichiers et les vérifications.", write=write)
            reports += f"\n{NAMES[a]} :\n{result}\n"

        review = await self.ask(reviewer, "vérification", f"{context}\n\nPlan :\n{plan}\n\n{reports}\n"
            "Vérifie les résultats des deux agents et signale les défauts ou vérifications manquantes.")
        final = await self.ask(planner, "bilan", f"{context}\n\nPlan :\n{plan}\n\n{reports}\n\nVérification :\n{review}\n\n"
            "Fais le bilan pour l'utilisateur, avec les résultats, les tests et les problèmes encore ouverts.")
        self.history.append(f"Utilisateur : {task}\n{reports}\nVérification : {review}\nBilan : {final}"[-16000:])
        self.turn_index += 1

