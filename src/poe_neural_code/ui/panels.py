"""Rendu des panneaux (fonctions pures → texte Rich) : todo et consommation.

Étiquettes de nature : [mesuré] renvoyé par le fournisseur · [estimé] calcul local (prix du modèle × taux saisi)
· [saisi] entré à la main · [indisponible]. Elles ne sont jamais additionnées entre elles à l'affichage.
Ces totaux ne couvrent QUE ce que cette application a enregistré : ce n'est pas l'historique du compte.
"""
from __future__ import annotations

import time
from datetime import datetime

from rich.text import Text

from ..budget import Budget, day_start, month_start
from ..config import Config
from ..provider.base import ModelInfo
from ..tools.base import TodoList
from .bars import labelled, pace
from .util import fmt_duration

TAG = {"measured": "mesuré", "estimated": "estimé", "manual": "saisi"}
ICON = {"pending": "☐", "in_progress": "◐", "done": "☑"}


def render_todo(todos: TodoList) -> Text:
    t = Text()
    done, total = todos.progress()
    t.append("Tâches", style="bold")
    t.append(f"  {done}/{total}\n" if total else "  (aucune)\n", style="dim")
    for i in todos.items:
        style = "green" if i.status == "done" else ("yellow" if i.status == "in_progress" else "")
        t.append(f"{ICON[i.status]} {i.content}\n", style=style)
    return t


def _pts(d: dict) -> str:
    parts = [f"{v:,.1f} pts [{TAG[k]}]".replace(",", " ") for k, v in d["points"].items() if v]
    out = " + ".join(parts) if parts else "0 pt"
    if d["points_unavailable_requests"]:
        out += f" · {d['points_unavailable_requests']} req. [indisponible]"
    return out


WINDOW_SECONDS = {"five_hour": 5 * 3600, "seven_day": 7 * 86400, "seven_day_opus": 7 * 86400, "seven_day_sonnet": 7 * 86400}
WINDOW_NAMES = {"five_hour": "5 h", "seven_day": "7 j", "seven_day_opus": "7 j Opus", "seven_day_sonnet": "7 j Sonnet"}
LABEL_W = 13
_AVAIL, _BAR, _LW = 200, 14, LABEL_W  # largeur disponible / largeur des barres / des libellés (réglés par render_usage selon compact)


def _section(t: Text, title: str, tag: str = "") -> None:
    """Titre de section : « ── Titre ─────── [étiquette] »."""
    t.append("\n")
    t.append("── ", style="#6b6b8a")
    t.append(title, style="bold #a78bfa")
    if tag:
        t.append(f"  {tag}", style="dim")
    t.append("\n")


def _row(t: Text, label: str, value: Text | str, tag: str = "") -> None:
    """Ligne « Libellé      valeur  [nature] » : libellés alignés ; la nature passe à la ligne suivante si la place manque."""
    vt = value if isinstance(value, Text) else Text(value)
    t.append(f"  {label:<{_LW}} ", style="#9a9ab5")
    t.append_text(vt)
    if tag:
        if 2 + _LW + 1 + len(vt.plain) + 2 + len(tag) > _AVAIL:
            t.append("\n" + " " * (3 + _LW))
            t.append(tag, style="dim")
        else:
            t.append(f"  {tag}", style="dim")
    t.append("\n")


def _points_rows(t: Text, label: str, d: dict, with_unavailable: bool = True) -> None:
    """Une ligne par nature de points (jamais additionnées) + les requêtes sans coût calculable."""
    shown = False
    for kind, fr in (("measured", "mesuré"), ("estimated", "estimé"), ("manual", "saisi")):
        v = d["points"].get(kind, 0)
        if v:
            _row(t, label if not shown else "", f"{v:,.1f} pts".replace(",", " "), f"[{fr}]")
            shown = True
    if not shown:
        _row(t, label, "0 pt")
    if with_unavailable and d["points_unavailable_requests"]:
        _row(t, "", f"{d['points_unavailable_requests']} req. sans coût", "[indisponible]")


def _kinds_fr(d: dict) -> str:
    m, e = d["tokens_in"]["measured"] + d["tokens_out"]["measured"], d["tokens_in"]["estimated"] + d["tokens_out"]["estimated"]
    return "mesurés" if m and not e else "estimés" if e and not m else "mesurés + estimés" if m and e else ""


def _tokens_line(d: dict) -> Text:
    tin = d["tokens_in"]["measured"] + d["tokens_in"]["estimated"]
    tout = d["tokens_out"]["measured"] + d["tokens_out"]["estimated"]
    return Text.assemble(("↓ ", "#60a5fa"), f"{tin:,}".replace(",", " "), ("   ↑ ", "#4ade80"), f"{tout:,}".replace(",", " "))


def render_claude(info, now: float) -> Text:
    """Fenêtres d'usage de l'abonnement Claude Code (MESURÉ par Claude Code)."""
    t = Text()
    wins = dict((info.rate or {}).get("unifiedWindows") or {})
    if info.rate and info.rate.get("rateLimitType") and info.rate["rateLimitType"] not in wins:
        wins[info.rate["rateLimitType"]] = info.rate
    _section(t, "Abonnement Claude Code", "[mesuré]")
    if not wins:
        _row(t, "Fenêtres", Text("indisponible (aucune donnée reçue pour l'instant)", style="yellow"))
    for k, w in wins.items():
        u = w.get("utilization")
        span = WINDOW_SECONDS.get(k)
        elapsed = None
        if w.get("resetsAt") and span:
            elapsed = max(0.0, min(1.0, 1 - (w["resetsAt"] - now) / span))
        name = WINDOW_NAMES.get(k, k)
        line = labelled("", u, width=_BAR)
        line.append_text(pace(u, elapsed))
        _row(t, f"Usage {name:>5}", line)
        if w.get("resetsAt"):
            _row(t, f"Temps {name:>5}", labelled("", elapsed, f"reset dans {fmt_duration(w['resetsAt'] - now)}", width=_BAR, color="#60a5fa"))
    _row(t, "Cache relu", f"{info.cache_read_tokens:,} tok (hors limite)".replace(",", " "), "[mesuré]")
    _row(t, "Équiv. API", f"${info.cost_usd_equiv:.4f} (indicatif, non facturé)", "[mesuré]")
    return t


def _budget_block(t: Text, budget: Budget, config: Config, mode: str, now: float, model, rem_points: list) -> None:
    envs = budget.envelopes()
    if mode != "poe":  # hors Poe : seules les limites de tokens ont un sens
        envs = [e for e in envs if e.token_limit is not None]
    if not envs:
        _section(t, "Budget")
        _row(t, "Aucun", Text("/define-token ou /limit pour en fixer un", style="yellow"))
        return
    for e in envs:
        st = budget.status(e)
        _section(t, f"Budget « {e.name} »", "(" + ("tous modèles" if "*" in e.scope else ", ".join(e.scope)) + ")")
        if st["remaining_points"] is not None:
            frac = (st["percent"] or 0) / 100
            _row(t, "Points", labelled("", frac, width=_BAR),
                 "[estimé]" if config.points_per_usd else "[saisi/estimé]")
            _row(t, "", Text(f"reste {max(st['remaining_points'], 0):,.1f} / {st['total_points']:,.1f}".replace(",", " ")
                             + (f"  (dont {st['held_points']:.1f} réservés)" if st["held_points"] else ""),
                             style="red" if st["remaining_points"] <= 0 else ""))
            rem_points.append(st["remaining_points"])
        if st["remaining_tokens"] is not None and e.token_limit:
            _row(t, "Tokens", labelled("", (e.token_limit - st["remaining_tokens"]) / e.token_limit, width=_BAR))
            _row(t, "", Text(f"reste {max(st['remaining_tokens'], 0):,} / {e.token_limit:,}".replace(",", " ")))
        if e.period_end and e.period_s:
            el = 1 - (e.period_end - now) / e.period_s
            _row(t, "Temps", labelled("", el, width=_BAR, color="#60a5fa"))
            _row(t, "", f"reste {fmt_duration(e.period_end - now)}")
            _row(t, "", Text(f"↻ {datetime.fromtimestamp(e.period_end):%d/%m %H:%M} · " + ("report du reliquat" if e.carry_over else "sans report")))
        else:
            _row(t, "Temps", "pas de renouvellement")
        _row(t, "Épuisement", "pause des requêtes" if e.on_exhaust == "pause" else "avertissement seulement")


def render_usage(budget: Budget, config: Config, model: ModelInfo | None, model_id: str | None, session_id: str,
                 session_tokens: dict | None = None, now: float | None = None, mode: str = "poe", claude_info=None, compact: bool = False) -> Text:
    """Consommation, dans l'ordre logique : fournisseur → session → budget → (abonnement) → totaux → légende."""
    global _AVAIL, _BAR, _LW
    _AVAIL, _BAR, _LW = (35, 9, 9) if compact else (200, 14, LABEL_W)
    now = now or time.time()
    t = Text()
    is_cli = mode == "claude" or mode.startswith("cli:")
    non_points = mode != "poe"
    t.append("CONSOMMATION\n", style="bold")

    # 1. Fournisseur / modèle
    if mode == "claude":
        _row(t, "Fournisseur", f"Claude Code · {(claude_info.model if claude_info and claude_info.model else config.claude_model) or 'modèle par défaut'}")
    elif is_cli:
        _row(t, "Agent", f"{mode[4:]} (délégué)")
        _row(t, "Aperçu cmd.", Text("indisponible", style="yellow"), "l'agent exécute ses outils")
    else:
        _row(t, "Fournisseur" if mode != "poe" else "Modèle", f"{mode} · {model_id or '—'}" if mode != "poe" else (model_id or "—"))
        if model_id and model is None:
            _row(t, "Prix modèle", Text("indisponible", style="red"))
        if mode == "poe" and not config.points_per_usd:
            _row(t, "Taux", Text("indisponible (/rate N)", style="yellow"), "points/USD")

    # 2. Session
    s = budget.totals(0, session_id=session_id)
    _section(t, "Cette session")
    _row(t, "Requêtes", str(s["requests"]))
    if s["requests"]:
        kinds = _kinds_fr(s)
        _row(t, "Tokens", _tokens_line(s), f"[{kinds}]" if kinds else "")
    else:
        _row(t, "Tokens", Text("indisponible (aucune requête)", style="dim"))
    if non_points:
        if s["usd"]:
            _row(t, "USD", f"≈ ${s['usd']:.4f}", "[mesuré, indicatif]" if mode == "claude" else "[estimé : prix catalogue × tokens]")
        _row(t, "Points", Text("sans objet", style="dim"))
    else:
        _points_rows(t, "Points", s)

    # 3. Budget
    rem: list = []
    _budget_block(t, budget, config, mode, now, model, rem)

    # 4. Abonnement Claude
    if mode == "claude" and claude_info is not None:
        t.append_text(render_claude(claude_info, now))

    # 5. Totaux locaux
    _section(t, "Totaux locaux")
    for label, since in (("Aujourd'hui", day_start(now)), ("Ce mois", month_start(now))):
        d = budget.totals(since)
        if non_points:
            _row(t, label, f"{d['requests']} req.")
        else:
            _points_rows(t, label, d, with_unavailable=False)
    # 6. Équivalent tokens (Poe)
    if rem and mode == "poe":
        eq = budget.tokens_equivalent(min(rem), model, config.points_per_usd)
        _row(t, "Reste ≈", (f"{eq[0]:,.0f} – {eq[1]:,.0f} tokens".replace(",", " ")) if eq else Text("estimation indisponible", style="yellow"),
             "[estimé, hors cache]" if eq else "")
    t.append("\nmesuré = renvoyé par le fournisseur · estimé = calculé ici · saisi = à la main · local : pas l'historique du compte\n", style="dim italic")
    return t


def render_header(sv, branch: str | None) -> Text:
    t = Text()
    t.append(f"{sv.session.title or 'Session ' + sv.session.id}\n", style="bold")
    t.append(f"{sv.ctx.workspace.root.name}", style="cyan")
    if branch:
        t.append(f"  ⎇ {branch}", style="magenta")
    t.append("\n")
    return t


def render_context(sv) -> Text:
    runner = sv.runner
    used = getattr(runner, "last_ctx_tokens", 0) or 0
    t = Text()
    t.append("Contexte\n", style="bold")
    if sv.is_cli:
        t.append(f"  {used:,} tokens (dernier tour) [{'mesuré' if sv.mode == 'claude' else 'mesuré/estimé'}]\n".replace(",", " "))
        return t
    win = sv.agent.window()
    t.append_text(labelled("  ", used / win if win else None, width=18))
    t.append(f"\n  {used:,} / {win:,} tok\n".replace(",", " "))
    return t


def render_files(modified: dict[str, str]) -> Text:
    t = Text()
    t.append("Fichiers modifiés\n", style="bold")
    if not modified:
        t.append("  (aucun)\n", style="dim")
    for path, st in list(modified.items())[-8:]:
        t.append(f"  {'✎' if st == 'write' else '✗'} {path}\n", style="green" if st == "write" else "red")
    return t


def render_ext(sv) -> Text:
    t = Text()
    t.append("Extensions\n", style="bold")
    mcp = sv.mcp.status()
    ok = sum(1 for m in mcp if m["state"] == "connected")
    t.append(f"  MCP {ok}/{len(mcp)}  ·  skills {len(sv.ext.skills)}\n")
    pl = sv.ext.plugins.plugins
    t.append(f"  plugins {sum(p.loaded for p in pl.values())}/{len(pl)}")
    pending = [p.name for p in pl.values() if not p.trusted]
    if pending:
        t.append(f"  ({len(pending)} à approuver)", style="yellow")
    t.append("\n")
    c = sv.config
    if c.fusion_enabled and c.fusion_helpers:
        t.append(f"  fusion ✓ {len(c.fusion_helpers)} assistant(s)\n", style="#f0abfc")
    return t
