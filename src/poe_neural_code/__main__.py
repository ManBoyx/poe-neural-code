from __future__ import annotations

import argparse
import asyncio
import sys
import time
from datetime import datetime

from . import __version__

SUBCOMMANDS = {"run", "models", "sessions", "export", "stats", "usage", "skills", "plugins", "modes", "agents", "providers", "login"}


def _services(path: str = "."):
    from .config import load_config
    from .services import create_services
    return create_services(path, config=load_config())


def cmd_models(args) -> int:
    async def go():
        from .provider.poe import PoeProvider
        p = PoeProvider()
        ms = [m for m in await p.list_models() if m.chat_text and m.supports_tools]
        await p.aclose()
        for m in sorted(ms, key=lambda m: m.id):
            eff = next((x for x in m.params if x.name in ("reasoning_effort", "effort", "thinking_level")), None)
            price = f"${m.prompt_price * 1e6:.2f}/${m.completion_price * 1e6:.2f}/Mtok" if m.prompt_price is not None else "prix indisponible"
            print(f"{m.id:40} ctx={m.context_length or '?':>8}  {price:26} " + (f"effort={'/'.join(eff.choices)}" if eff else ""))
    asyncio.run(go())
    return 0


def cmd_sessions(args) -> int:
    from .session import list_sessions
    for s in list_sessions():
        print(f"{s.id}  {datetime.fromtimestamp(s.updated):%Y-%m-%d %H:%M}  {s.mode:6} {s.agent:6} {s.workspace}  {s.title}")
    return 0


def cmd_export(args) -> int:
    sv = _services_for_session(args.id)
    print(sv.export_markdown())
    return 0


def _services_for_session(sid: str):
    from .config import load_config
    from .services import create_services
    return create_services(".", resume=sid, config=load_config())


def cmd_stats(args) -> int:
    from .budget import Budget, day_start, month_start
    b = Budget()
    now = time.time()
    for label, since in (("aujourd'hui", day_start(now)), ("ce mois", month_start(now)), ("total", 0)):
        t = b.totals(since)
        pts = " + ".join(f"{v:.1f} pts [{k}]" for k, v in t["points"].items() if v) or "0 pt"
        print(f"{label:12} {t['requests']} req · {pts} · tokens ↓{sum(t['tokens_in'].values())} ↑{sum(t['tokens_out'].values())}"
              + (f" · {t['points_unavailable_requests']} req. points indisponibles" if t["points_unavailable_requests"] else ""))
    print("(registre LOCAL : ce n'est pas l'historique du compte)")
    return 0


def cmd_list(args) -> int:
    sv = _services(".")
    if args.cmd == "skills":
        for n, s in sv.ext.skills.items():
            print(f"{n:30} {s.scope:8} {s.description[:80]}")
    elif args.cmd == "plugins":
        for p in sv.ext.plugins.plugins.values():
            print(f"{p.name:20} {p.scope:8} {'approuvé' if p.trusted else 'NON approuvé'}  {p.path}")
    else:
        for n, m in sv.ext.modes.items():
            print(f"{n:20} {m.scope:8} {'lecture seule' if m.readonly else 'complet':14} {m.description}")
    return 0


def cmd_agents(args) -> int:
    """Agents IA détectés sur l'ordinateur (Claude Code, OpenCode, Gemini CLI, Codex, Kiro, personnalisés)."""
    from .cli_agents import detect
    for d in detect(with_version=True):
        a = d.adapter
        print(f"{'✓' if d.installed else '✗'} {a.label:14} {d.path or 'non installé':40} {d.version:20} {a.verified}")
    return 0


def cmd_providers(args) -> int:
    from . import credentials
    from .providers import all_specs, has_credentials
    for s in all_specs():
        st = "local" if not s.key_required else ("clé ✓" if has_credentials(s) else "sans clé")
        print(f"{s.id:12} {s.label:22} {st:9} {s.base_url}   [{s.verified}]")
    print(f"\nStockage des clés : {credentials.storage_kind()}")
    return 0


def cmd_login(args) -> int:
    """eclipse login ID : saisit la clé d'API (masquée), la vérifie, l'enregistre."""
    import getpass
    from . import credentials
    from .providers import build_provider, get_spec
    spec = get_spec(args.id)
    if spec is None:
        print(f"Fournisseur inconnu : {args.id} (voir `eclipse providers`)", file=sys.stderr)
        return 1
    key = getpass.getpass(f"Clé d'API {spec.label} (saisie masquée) : ") if spec.key_required else None
    if key:
        credentials.set_key(spec.id, key)
    prov = build_provider(spec)
    ok, msg = asyncio.run(prov.verify())  # type: ignore[attr-defined]
    asyncio.run(prov.aclose())
    if not ok and key:
        credentials.delete_key(spec.id)
    print(("✓ " if ok else "✗ ") + msg + (f"  (stockée : {credentials.storage_kind()})" if ok and key else ""))
    return 0 if ok else 1


def cmd_run(args) -> int:
    """Une demande non interactive (scripts/CI). Les autorisations sont demandées sur le terminal ; sans terminal, tout est refusé sauf lecture."""
    from .agent import AssistantDelta, StatusEvent, ToolFinished, ToolRequested

    async def go() -> int:
        sv = _services(args.path)
        if args.provider:
            from .cli_agents import get_adapter
            prov = args.provider if (args.provider == "claude" or args.provider.startswith("cli:") or not get_adapter(args.provider)) else "cli:" + args.provider
            sv.set_mode(prov)
        if args.model:
            sv.session.model = args.model
            sv.config.claude_model = args.model if sv.mode == "claude" else sv.config.claude_model
        if args.agent:
            sv.set_agent(args.agent)

        async def ask(req):
            if not sys.stdin.isatty():
                print(f"[refusé sans terminal] {req.summary}", file=sys.stderr)
                return "deny"
            print(f"\n⚠ {req.summary}\n{req.detail[:2000]}", file=sys.stderr)
            r = input("Autoriser ? [o]ui / [n]on : ").strip().lower()
            return "once" if r.startswith("o") else "deny"

        sv.ctx.permissions.asker = ask
        if args.bypass:
            sv.ctx.permissions.set_mode("bypass")
            print("⚠ BYPASS : aucune confirmation (hors destructif / hors projet).", file=sys.stderr)

        def emit(e):
            if isinstance(e, AssistantDelta):
                print(e.text, end="", flush=True)
            elif isinstance(e, ToolRequested):
                print(f"\n▸ {e.name} {e.args}", file=sys.stderr)
            elif isinstance(e, ToolFinished):
                print(f"  {'✓' if e.ok else '✗'} {e.output[:200]}", file=sys.stderr)
            elif isinstance(e, StatusEvent):
                print(f"[{e.level}] {e.text}", file=sys.stderr)

        sv.agent.emit = emit
        sv.claude.emit = emit
        await sv.start_mcp()
        await sv.load_models()
        await sv.run_user_turn(" ".join(args.prompt))
        print()
        await sv.close()
        return 0

    return asyncio.run(go())


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in SUBCOMMANDS:
        ap = argparse.ArgumentParser(prog=f"eclipse {argv[0]}")
        sub = argv[0]
        if sub == "run":
            ap.add_argument("prompt", nargs="+")
            ap.add_argument("--path", default=".")
            ap.add_argument("--provider", help="poe, openrouter…, claude ou cli:opencode / opencode")
            ap.add_argument("--model")
            ap.add_argument("--agent")
            ap.add_argument("--bypass", action="store_true", help="aucune confirmation (sudo refusé ; destructif/hors projet : toujours confirmé)")
        elif sub in ("export", "login"):
            ap.add_argument("id")
        a = ap.parse_args(argv[1:])
        a.cmd = sub
        return {"run": cmd_run, "models": cmd_models, "sessions": cmd_sessions, "export": cmd_export, "stats": cmd_stats, "usage": cmd_stats, "agents": cmd_agents, "providers": cmd_providers, "login": cmd_login}.get(sub, cmd_list)(a)
    ap = argparse.ArgumentParser(prog="eclipse", description="Eclipse (POE · Neural Code) — agent de programmation en terminal",
                                 epilog="Sous-commandes : run, models, sessions, export, stats, skills, plugins, modes, agents, providers, login")
    ap.add_argument("path", nargs="?", help="projet à ouvrir")
    ap.add_argument("--resume", metavar="ID", help="reprendre une session")
    ap.add_argument("--version", action="version", version=f"eclipse {__version__}")
    ap.add_argument("--check", action="store_true", help="affiche l'état de la configuration, sans interface")
    a = ap.parse_args(argv)
    if a.check:
        import os
        from .config import load_config
        from .paths import data_dir
        c = load_config()
        print(f"données : {data_dir()}\nPOE_API_KEY : {'présente' if os.environ.get('POE_API_KEY') else 'ABSENTE (aucune réponse ne sera simulée)'}")
        print(f"modèle : {c.model or 'non choisi (/models)'}\ntaux points/USD : {c.points_per_usd or 'non défini (/rate)'}")
        return 0
    from .ui.app import EclipseApp
    EclipseApp(a.path, a.resume).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
