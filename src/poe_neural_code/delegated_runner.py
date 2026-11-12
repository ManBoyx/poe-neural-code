"""Lanceur « délégué » : un agent IA externe (OpenCode, Gemini CLI, Codex, Kiro, personnalisé) passe par le contrôle des tokens d'Eclipse.

Ce qu'Eclipse fait : limite de tokens avant et PENDANT le tour (estimation si l'agent ne donne pas de compteur), journal de consommation étiqueté
mesuré/estimé, archivage mémoire, interruption (processus tué), mode « plan » transmis quand l'agent le permet, contexte Eclipse fourni aux agents sans session.
Ce qu'Eclipse NE fait PAS : prévisualiser/autoriser les commandes de l'agent externe (il exécute ses propres outils) — annoncé à chaque nouvelle session.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, Callable

from . import budget as B
from .agent import AssistantDelta, AssistantMessage, Paused, StatusEvent, TurnDone, UsageEvent
from .cli_agents import CliAdapter, build_command, parse_opencode_line
from .config import Config
from .logs import get_logger, redact
from .memory.context import build_context
from .memory.engine import Memory, estimate_tokens
from .session import Session
from .tools.base import ToolContext
from .tools.exec_tool import kill_tree

log = get_logger()


class DelegatedRunner:
    def __init__(self, config: Config, budget: B.Budget, memory: Memory, ctx: ToolContext, session: Session, emit: Callable[[Any], None],
                 adapter: CliAdapter, binary: str | None):
        self.config, self.budget, self.memory, self.ctx, self.session, self.emit = config, budget, memory, ctx, session, emit
        self.adapter, self.binary = adapter, binary
        self.last_ctx_tokens = 0
        self.pending_context: list[str] = []
        self.ext = None
        self._busy = False
        self._warned = False

    @property
    def scope_id(self) -> str:
        return self.adapter.scope_id

    def interrupt(self) -> None:
        self.ctx.cancel.set()

    def _remaining_tokens(self) -> int | None:
        rem = None
        for e in self.budget.envelopes():
            if e.token_limit is not None and B.Budget._in_scope(e, self.scope_id):
                r = self.budget.status(e)["remaining_tokens"]
                rem = r if rem is None else min(rem, r)
        return rem

    async def run_turn(self, user_text: str) -> None:
        if self._busy:
            self.emit(StatusEvent("Un tour est déjà en cours.", "warn"))
            return
        self._busy = True
        self.ctx.cancel.clear()
        interrupted = False
        try:
            interrupted = await self._turn(user_text)
        except Exception as e:  # noqa: BLE001
            log.exception("delegated runner")
            self.emit(StatusEvent(redact(f"Erreur {self.adapter.label} : {e.__class__.__name__}: {e}"), "error"))
        finally:
            self._busy = False
            self.session.todos = self.ctx.todos.to_json()
            self.session.save()
            self.emit(TurnDone(interrupted))

    async def _turn(self, user_text: str) -> bool:
        a = self.adapter
        if not self.binary:
            self.emit(StatusEvent(f"{a.label} introuvable sur cette machine (binaire « {a.binary} » absent du PATH).", "error"))
            return False
        sess_id = self.session.cli_sessions.get(a.id)
        prefix = "".join(n + "\n\n" for n in self.pending_context)
        self.pending_context.clear()
        prompt = prefix + user_text
        if not sess_id:  # agent sans session (ou première fois) : contexte structuré d'Eclipse, SEULEMENT s'il existe, APRÈS la demande
            pack = build_context(self.memory, self.session.district_id, self.session.conversation_id, token_budget=2500)
            if pack.refs:
                body = pack.text.split("\n", 1)[1].strip() if "\n" in pack.text else pack.text  # sans l'en-tête destiné aux prompts système
                prompt = f"{prompt}\n\n(Notes de travail du projet, fournies à titre informatif :)\n{body}"
        est_in = estimate_tokens(prompt)
        try:
            res = self.budget.reserve(self.session.id, self.scope_id, None, est_in, bounded=False)
        except B.BudgetExhausted as e:
            self.emit(Paused(str(e)))
            return False
        if not self._warned:
            self._warned = True
            self.emit(StatusEvent(f"Mode délégué « {a.label} » : l'agent exécute ses PROPRES outils, Eclipse ne peut pas en prévisualiser les commandes. "
                                  f"Eclipse mesure/estime les tokens et applique votre limite (/claude-limit s'applique aussi : portée « {self.scope_id} »). "
                                  + (a.notes or ""), "warn"))
        self.memory.archive_message(self.session.conversation_id, "user", user_text)
        plan = self.session.agent == "plan"
        if plan and not a.plan_args:
            self.emit(StatusEvent(f"Mode plan : {a.label} n'a pas d'option lecture seule connue — il pourrait modifier des fichiers.", "warn"))
        cmd, stdin_text = build_command(a, self.binary, prompt, model=self.config.cli_models.get(a.id), plan=plan, session_id=sess_id,
                                     bypass=self.ctx.permissions.mode == "bypass")
        if self.ctx.permissions.mode == "bypass" and not plan:
            self.emit(StatusEvent(f"BYPASS : {'les confirmations de ' + a.label + ' sont désactivées (' + ' '.join(a.bypass_args) + ')' if a.bypass_args else a.label + ' n’a pas d’option bypass connue : ses propres confirmations restent actives'}.", "warn"))
        env = {k: v for k, v in os.environ.items() if k not in ("POE_API_KEY",)}
        try:
            proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(self.ctx.workspace.root), env=env,
                                                        stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=32 * 1024 * 1024,
                                                        **({"start_new_session": True} if os.name != "nt" else {}))
        except (FileNotFoundError, PermissionError) as e:
            self.budget.release(res)
            self.emit(StatusEvent(f"Lancement impossible : {e}", "error"))
            return False
        assert proc.stdout and proc.stderr
        if stdin_text is not None and proc.stdin:
            proc.stdin.write(stdin_text.encode())
            await proc.stdin.drain()
            proc.stdin.close()
        err_task = asyncio.create_task(proc.stderr.read())
        parts: list[str] = []
        measured: tuple[int, int] | None = None
        interrupted = limit_hit = False
        try:
            while True:
                rl = asyncio.ensure_future(proc.stdout.readline())
                cn = asyncio.ensure_future(self.ctx.cancel.wait())
                done, _ = await asyncio.wait({rl, cn}, return_when=asyncio.FIRST_COMPLETED)
                if rl not in done:
                    rl.cancel()
                    interrupted = True
                    await kill_tree(proc)
                    break
                cn.cancel()
                raw = rl.result()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace")
                if a.output == "opencode-json":
                    ev = parse_opencode_line(line.strip())
                    if ev.get("session"):
                        self.session.cli_sessions[a.id] = ev["session"]
                    if ev.get("tokens"):
                        measured = ev["tokens"]
                    txt = ev.get("text")
                else:
                    txt = line
                if txt:
                    parts.append(txt)
                    self.emit(AssistantDelta(txt))
                rem = self._remaining_tokens()
                used = est_in + estimate_tokens("".join(parts))
                if rem is not None and used >= rem and not limit_hit:
                    limit_hit = True
                    self.emit(Paused(f"Limite de tokens atteinte (≈{used} estimés ≥ reste {max(rem, 0)}) — {a.label} arrêté."))
                    await kill_tree(proc)
                    break
            if proc.returncode is None:
                await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            await kill_tree(proc)
        stderr = (await err_task).decode(errors="replace")[-500:]
        text = "".join(parts).strip()
        if text:
            self.memory.archive_message(self.session.conversation_id, "assistant", text)
            self.emit(AssistantMessage(text))
        if measured:
            tin, tout, kind = measured[0], measured[1], "measured"
        else:
            tin, tout, kind = est_in, estimate_tokens(text) if text else 0, "estimated"
        self.last_ctx_tokens = tin
        self.budget.commit(res, session_id=self.session.id, model=self.scope_id, tokens_in=tin, tokens_out=tout, tokens_kind=kind, points=None,
                           points_kind="unavailable", usd=None,
                           note=("interrompu ; " if interrupted else "") + ("usage mesuré par l'agent" if measured else "tokens ESTIMÉS (caractères/4) : l'agent ne fournit pas de compteur"))
        self.emit(UsageEvent())
        for name, pct in self.budget.pending_alerts():
            self.emit(StatusEvent(f"ALERTE budget « {name} » : {pct} % atteint", "warn"))
        if interrupted:
            self.emit(StatusEvent("Opération interrompue.", "warn"))
            return True
        if proc.returncode not in (0, None) and not limit_hit:
            self.emit(StatusEvent(redact(f"{a.label} a échoué (code {proc.returncode}). {stderr.strip()[:300]}"), "error"))
        return limit_hit
