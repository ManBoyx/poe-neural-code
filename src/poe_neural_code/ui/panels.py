"""Rendu des panneaux (fonctions pures → texte Rich) : todo et consommation.

Étiquettes de nature : [mesuré] renvoyé par le fournisseur · [estimé] calcul local (prix du modèle × taux saisi)
· [saisi] entré à la main · [indisponible]. Elles ne sont jamais additionnées entre elles à l'affichage.
Ces totaux ne couvrent QUE ce que cette application a enregistré : ce n'est pas l'historique du compte.
"""
from __future__ import annotations

import time
from datetime import datetime

from rich.table import Table
from rich.text import Text

from ..budget import Budget, day_start, month_start
from ..config import Config
from ..provider.base import ModelInfo
from ..tools.base import TodoList
from .bars import labelled, pace
from .util import fmt_duration

TAG = {"measured": "mesuré", "estimated": "estimé", "manual": "saisi"}
from . import icons as I


def _todo_icon(status: str) -> str:
    return I.get({"pending": "todo_open", "in_progress": "todo_doing", "done": "todo"}[status])


def render_todo(todos: TodoList) -> Text:
    t = Text()
    done, total = todos.progress()
    t.append("Tâches", style="bold")
    t.append(f"  {done}/{total}\n" if total else "  (aucune)\n", style="dim")
    for i in todos.items:
        style = "green" if i.status == "done" else ("yellow" if i.status == "in_progress" else "")
        t.append(f"{_todo_icon(i.status)} {i.content}\n", style=style)
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


SUBSCRIPTION_NOTE = {"claude": "Claude Code", "cli:codex": "Codex", "cli:kiro": "Kiro", "cli:gemini": "Gemini CLI", "cli:opencode": "OpenCode"}
BORDER = "#3d3d5c"


def _grid(label_w: int) -> Table:
    g = Table.grid(padding=(0, 1), expand=True)
    g.add_column(style="#9a9ab5", no_wrap=True, width=label_w)
    g.add_column(ratio=1)
    return g


def _tagged(value: str | Text, tag: str = "", tag_style: str = "dim") -> Text:
    t = value.copy() if isinstance(value, Text) else Text(value)
    if tag:
        t.append(f"  {tag}", style=tag_style)
    return t


def _panel(icon: str, title: str, body, nature: str = "", color: str = "#a78bfa"):
    from rich.panel import Panel
    return Panel(body, title=Text.assemble((f"{I.get(icon)} ", color), (title, f"bold {color}")), title_align="left",
                 subtitle=Text(nature, style="dim") if nature else None, subtitle_align="right", border_style=BORDER, padding=(0, 1), expand=True)


def _windows(info) -> dict:
    wins = dict((info.rate or {}).get("unifiedWindows") or {})
    if info.rate and info.rate.get("rateLimitType") and info.rate["rateLimitType"] not in wins:
        wins[info.rate["rateLimitType"]] = info.rate
    return wins


def render_claude(info, now: float, bar_w: int | None = None, label_w: int | None = None):
    """Abonnement Claude Code : une sous-partie par fenêtre d'usage (5 h, 7 j…), valeurs MESURÉES par Claude Code."""
    from rich.console import Group
    bw, lw = bar_w or _BAR, label_w or _LW
    parts: list = []
    wins = _windows(info)
    if not wins:
        parts.append(Text("Fenêtres d'usage : pas encore reçues (elles arrivent avec la première réponse).", style="yellow"))
    for i, (k, w) in enumerate(wins.items()):
        u = w.get("utilization")
        span = WINDOW_SECONDS.get(k)
        elapsed = max(0.0, min(1.0, 1 - (w["resetsAt"] - now) / span)) if w.get("resetsAt") and span else None
        if i:
            parts.append(Text(""))
        parts.append(Text.assemble((f"{I.get('window')} Fenêtre {WINDOW_NAMES.get(k, k)}", "bold")))
        g = _grid(lw)
        g.add_row("Utilisé", labelled("", u, width=bw))
        if elapsed is not None:
            g.add_row("Écoulé", labelled("", elapsed, width=bw, color="#60a5fa"))
        if u is not None and elapsed:
            r = u / elapsed if elapsed > 0.02 else None
            if r is not None:
                g.add_row("Rythme", Text.assemble((f"{I.get('trend_down')} sous le temps", "#4ade80")) if r <= 0.9 else
                          (Text.assemble((f"{I.get('trend_flat')} au rythme du temps", "#fbbf24")) if r <= 1.15 else
                           Text.assemble((f"{I.get('trend_up')} plus vite que le temps", "#f87171"))))
        if w.get("resetsAt"):
            g.add_row("Renouvelée", f"dans {fmt_duration(w['resetsAt'] - now)}")
            g.add_row("", Text(f"le {datetime.fromtimestamp(w['resetsAt']):%d/%m à %H:%M}", style="dim"))
        parts.append(g)
    return _panel("subscription", "Abonnement Claude Code", Group(*parts), "mesuré par Claude Code")


def _budget_panels(budget: Budget, config: Config, mode: str, now: float, rem_points: list) -> list:
    """Budgets LOCAUX d'Eclipse. Avec un abonnement (Claude Code, Codex…), seules les limites /limit propres à cet agent s'affichent."""
    subscription = mode == "claude" or mode.startswith("cli:")
    envs = budget.envelopes()
    if subscription:
        scope = "claude-code" if mode == "claude" else mode
        envs = [e for e in envs if e.token_limit is not None and scope in e.scope]
    elif mode != "poe":
        envs = [e for e in envs if e.token_limit is not None]
    out = []
    for e in envs:
        st = budget.status(e)
        g = _grid(_LW)
        if st["remaining_points"] is not None and not subscription:
            g.add_row("Points", labelled("", (st["percent"] or 0) / 100, width=_BAR))
            g.add_row("Reste", _tagged(f"{max(st['remaining_points'], 0):,.0f} / {st['total_points']:,.0f} pts".replace(",", " "),
                                       "estimé" if config.points_per_usd else "saisi"))
            if st["held_points"]:
                g.add_row("", Text(f"dont {st['held_points']:.1f} réservés (en cours)", style="dim"))
            rem_points.append(st["remaining_points"])
        if st["remaining_tokens"] is not None and e.token_limit:
            g.add_row("Tokens", labelled("", (e.token_limit - st["remaining_tokens"]) / e.token_limit, width=_BAR))
            g.add_row("Reste", f"{max(st['remaining_tokens'], 0):,} / {e.token_limit:,} tok".replace(",", " "))
        if e.period_end and e.period_s:
            g.add_row("Période", labelled("", 1 - (e.period_end - now) / e.period_s, width=_BAR, color="#60a5fa"))
            g.add_row("Renouvelée", f"dans {fmt_duration(e.period_end - now)}")
            g.add_row("", Text(f"le {datetime.fromtimestamp(e.period_end):%d/%m à %H:%M}", style="dim"))
            g.add_row("Reliquat", "reporté" if e.carry_over else "non reporté")
        else:
            g.add_row("Période", "sans renouvellement")
        g.add_row("Si épuisé", "pause des requêtes" if e.on_exhaust == "pause" else "avertissement seulement")
        title = ("Limite Eclipse" if subscription else f"Budget « {e.name} »")
        scope_txt = "tous modèles" if "*" in e.scope else ", ".join(e.scope)
        out.append(_panel("budget", title, g, scope_txt, color="#fbbf24"))
    if not out and not subscription:
        g = _grid(_LW)
        g.add_row("Aucun", Text("/define-token (points/tokens) ou /limit (tokens)", style="yellow"))
        out.append(_panel("budget", "Budget", g, color="#fbbf24"))
    return out


def render_usage(budget: Budget, config: Config, model: ModelInfo | None, model_id: str | None, session_id: str,
                 session_tokens: dict | None = None, now: float | None = None, mode: str = "poe", claude_info=None, compact: bool = False):
    """Consommation en cadres séparés, dans l'ordre : fournisseur → (abonnement) → session → budget → totaux → légende."""
    from rich.console import Group
    global _AVAIL, _BAR, _LW
    _AVAIL, _BAR, _LW = (40, 14, 11) if compact else (200, 24, 16)
    now = now or time.time()
    subscription = mode == "claude" or mode.startswith("cli:")
    panels: list = []

    # 1. Fournisseur
    g = _grid(_LW)
    if mode == "claude":
        g.add_row("Fournisseur", "Claude Code")
        g.add_row("Facturation", "abonnement")
        g.add_row("Modèle", (claude_info.model if claude_info and claude_info.model else config.claude_model) or "par défaut")
    elif subscription:
        g.add_row("Agent", f"{SUBSCRIPTION_NOTE.get(mode, mode[4:])} (délégué)")
        g.add_row("Modèle", config.cli_models.get(mode[4:]) or "celui de l'agent")
        g.add_row("Aperçu cmd.", Text("indisponible (outils de l'agent)", style="yellow"))
    else:
        g.add_row("Fournisseur", mode if mode != "poe" else "Poe")
        g.add_row("Modèle", model_id or Text("aucun (/models)", style="yellow"))
        if model_id and model is None:
            g.add_row("Prix", Text("indisponible", style="red"))
        elif model is not None and model.free:
            g.add_row("Prix", Text("gratuit", style="#4ade80"))
        if mode == "poe":
            g.add_row("Taux", f"{config.points_per_usd:g} pts/USD (saisi)" if config.points_per_usd else Text("pts/USD indisponible (/rate)", style="yellow"))
    panels.append(_panel("agent" if subscription else "provider", "Fournisseur", g))

    # 2. Abonnement
    if mode == "claude" and claude_info is not None:
        panels.append(render_claude(claude_info, now))
    elif subscription:
        g = _grid(_LW)
        g.add_row("Quotas", Text(f"gérés par l'abonnement {SUBSCRIPTION_NOTE.get(mode, mode[4:])} ; non communiqués à Eclipse", style="dim"))
        panels.append(_panel("subscription", "Abonnement", g))

    # 3. Session
    s = budget.totals(0, session_id=session_id)
    g = _grid(_LW)
    g.add_row("Requêtes", str(s["requests"]))
    if s["requests"]:
        g.add_row("Tokens", _tagged(_tokens_line(s), _kinds_fr(s)))
    else:
        g.add_row("Tokens", Text("aucune requête", style="dim"))
    if mode == "claude":
        if claude_info is not None:
            g.add_row("Cache relu", f"{claude_info.cache_read_tokens:,}".replace(",", " ") + " tok")
            g.add_row("Équiv. API", _tagged(f"${claude_info.cost_usd_equiv:.4f}", "non facturé"))
    elif mode != "poe" and not subscription:
        g.add_row("Coût", _tagged(f"≈ ${s['usd']:.4f}", "estimé") if s["usd"] else Text("—", style="dim"))
    elif mode == "poe":
        shown = False
        for kind, fr in (("measured", "mesuré"), ("estimated", "estimé"), ("manual", "saisi")):
            v = s["points"].get(kind, 0)
            if v:
                g.add_row("Points" if not shown else "", _tagged(f"{v:,.1f} pts".replace(",", " "), fr))
                shown = True
        if not shown:
            g.add_row("Points", "0 pt")
        if s["points_unavailable_requests"]:
            g.add_row("", _tagged(f"{s['points_unavailable_requests']} req. sans coût calculable", "indisponible"))
    panels.append(_panel("session", "Cette session", g, color="#22d3ee"))

    # 4. Budgets locaux
    rem: list = []
    panels += _budget_panels(budget, config, mode, now, rem)

    # 5. Totaux locaux
    g = _grid(_LW)
    for label, since in (("Aujourd'hui", day_start(now)), ("Ce mois", month_start(now))):
        d = budget.totals(since)
        if mode == "poe":
            pts = " + ".join(f"{v:,.1f} pts ({fr})".replace(",", " ") for (k, v), fr in zip(d["points"].items(), ("mesuré", "estimé", "saisi")) if v) or "0 pt"
            g.add_row(label, f"{d['requests']} req.")
            g.add_row("", pts)
        else:
            g.add_row(label, f"{d['requests']} req. · {sum(d['tokens_in'].values()) + sum(d['tokens_out'].values()):,} tok".replace(",", " "))
    if rem and mode == "poe":
        eq = budget.tokens_equivalent(min(rem), model, config.points_per_usd)
        g.add_row("Reste ≈", _tagged(f"{eq[0]:,.0f} – {eq[1]:,.0f} tok".replace(",", " "), "estimé") if eq else Text("estimation indisponible", style="yellow"))
    panels.append(_panel("chart", "Totaux locaux", g, "cette application seulement", color="#9a9ab5"))

    legend = Text("mesuré = renvoyé par le fournisseur · estimé = calculé ici · saisi = entré à la main", style="dim italic")
    return Group(*panels, legend)


def render_header(sv, branch: str | None) -> Text:
    t = Text()
    t.append(f"{sv.session.title or 'Session ' + sv.session.id}\n", style="bold")
    t.append(f"{sv.ctx.workspace.root.name}", style="cyan")
    if branch:
        t.append(f"  {I.get('branch')} {branch}", style="magenta")
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
        t.append(f"  {I.get('edit') if st == 'write' else I.get('delete')} {path}\n", style="green" if st == "write" else "red")
    return t


def render_ext(sv) -> Text:
    t = Text()
    t.append("EXTENSIONS\n", style="bold")
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
        t.append(f"  {I.get('helper')} fusion · {len(c.fusion_helpers)} assistant(s)\n", style="#f0abfc")
    return t


def render_tools_tab(sv) -> Text:
    """Onglet « Outils » : permissions, dossiers, extensions, MCP, fusion, skills."""
    t = Text()
    pm = sv.ctx.permissions
    t.append("PERMISSIONS\n", style="bold")
    t.append(f"  {pm.mode}" + (" (total)" if pm.bypass_all else ""), style="bold #f87171" if pm.mode == "bypass" else ("#fbbf24" if pm.mode == "edits" else "#4ade80"))
    t.append("  ·  /permissions\n", style="dim")
    t.append("\nDOSSIERS AUTORISÉS\n", style="bold")
    for r in sv.ctx.workspace.roots():
        t.append(f"  {r}\n", style="cyan")
    t.append("\n")
    t.append_text(render_ext(sv))
    mcp = sv.mcp.status()
    if mcp:
        t.append("\nSERVEURS MCP\n", style="bold")
        for m in mcp:
            t.append(f"  {'●' if m['state'] == 'connected' else '○'} {m['name']} ({m['tools']})\n", style="#4ade80" if m["state"] == "connected" else "#fbbf24")
    c = sv.config
    t.append("\nFUSION\n", style="bold")
    if c.fusion_helpers:
        t.append(f"  {'activée' if c.fusion_enabled else 'désactivée'} · max {c.fusion_max_calls}/tour\n", style="#f0abfc" if c.fusion_enabled else "dim")
        for h in c.fusion_helpers:
            t.append(f"  · {h}\n")
    else:
        t.append("  aucun assistant (/fusion)\n", style="dim")
    if sv.ext.skills:
        t.append("\nSKILLS\n", style="bold")
        for n, sk in list(sv.ext.skills.items())[:12]:
            t.append(f"  · {n}", style="")
            t.append(f" ({sk.scope})\n", style="dim")
    modes = [n for n, m in sv.ext.modes.items() if m.primary]
    t.append("\nMODES (Tab)\n", style="bold")
    t.append("  " + "  ".join((I.get("chevron") if n == sv.session.agent else "") + n for n in modes) + "\n")
    return t
