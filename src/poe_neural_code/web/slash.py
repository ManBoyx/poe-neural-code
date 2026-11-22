"""Commandes « / » du CLI exécutées par le moteur pour l'application desktop (même logique, réponses en texte).

Chaque commande renvoie un dict : ok, message (notification courte) ou title + text (fenêtre d'information), state (l'interface doit
relire l'état), need_confirm (action sensible : l'interface demande confirmation puis renvoie `confirmed: true`), turn (un tour démarre).
Les commandes purement d'interface (barre latérale, thème, pièce jointe…) sont gérées par l'interface elle-même.
"""
from __future__ import annotations

import asyncio
import json

from .. import connections as CX
from .. import fusion as F
from .. import variants
from ..cli_agents import get_adapter
from ..config import save_config
from ..extensions.commands import BUILTINS, INIT_PROMPT
from ..paths import data_dir

# Commandes du CLI exécutées ici (les autres sont dans l'interface ou sans objet dans une fenêtre)
ENGINE = ("doctor", "context", "status", "mcp", "skills", "plugins", "todo", "system", "fusion", "permissions", "bypass", "claude-limit", "limit",
          "rate", "spent", "define-token", "reload", "add-dir", "verify", "free", "init", "detect", "agent-path", "disconnect", "logout", "options",
          "provider", "agents", "modes", "effort", "cg")


def catalog() -> list[dict]:
    """Description et usage des commandes du CLI (aide intégrée du desktop)."""
    return [{"name": c.name, "description": c.description, "usage": c.usage, "aliases": list(c.aliases)} for c in BUILTINS]


def _fmt(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def _msg(text: str, ok: bool = True, state: bool = False) -> dict:
    return {"ok": ok, "message": text, "state": state}


def _info(title: str, text: str, state: bool = False) -> dict:
    return {"ok": True, "title": title, "text": text, "state": state}


async def run(hub, name: str, args: str, confirmed: bool = False) -> dict:
    sv = hub.sv
    name = {"limit": "claude-limit", "logout": "disconnect", "modes": "agents"}.get(name, name)
    args = (args or "").strip()

    if name == "cg":
        try:
            await hub.open(str(sv.ctx.workspace.root), cg=True)
        except (OSError, RuntimeError) as exc:
            return _msg(f"/cg : {exc}", ok=False)
        return {"ok": True, "state": True}

    if name == "doctor":
        from ..diagnostics import doctor
        checks = await doctor(sv)
        mark = {"ok": "[ok]", "warn": "[!!]", "fail": "[XX]", "info": "[--]"}
        return _info("Diagnostic (/doctor)", "\n".join(f"{mark.get(c.status, '[--]')} {c.name} : {c.detail}" for c in checks))

    if name == "context":
        from ..diagnostics import context_breakdown
        d = context_breakdown(sv)
        lines = [f"{n:>9}  {name_}" for name_, n in [(p, _fmt(n)) for p, n in d["parts"]]]
        lines.append(f"{_fmt(d['total']):>9}  Total estimé")
        if d["window"]:
            lines.append(f"\nFenêtre du modèle : {_fmt(d['total'])} / {_fmt(d['window'])} tokens ({d['total'] / d['window'] * 100:.0f} %)")
            lines.append(f"Réservé aux réponses et résultats d'outils : {d['reserve_ratio'] * 100:.0f} % · utilisable ≈ {_fmt(d['usable'])}")
        lines.append("Estimation ≈ 4 caractères/token. /compact pour résumer l'ancien historique (archives conservées).")
        return _info("Contexte (/context)", "\n".join(lines))

    if name == "status":
        det = await asyncio.to_thread(CX.agents, False, False, sv.config)
        rows = [("Fournisseur", sv.mode_label + ("" if sv.is_cli else f" (clé : {'présente' if sv.provider.configured() else 'ABSENTE → Connexions'})")),
                ("Agents détectés", ", ".join(d["label"] for d in det if d["installed"]) or "aucun"),
                ("Mode", sv.session.agent),
                ("Modèle", hub.current_model() or "défaut"),
                ("Réglages", variants.summary(sv.model_params(), sv.current_options()) or "(défauts du modèle)"),
                ("Effort par défaut", sv.config.default_effort),
                ("Permissions", sv.ctx.permissions.mode + (" (TOTAL)" if sv.ctx.permissions.bypass_all else "")),
                ("Projet", str(sv.ctx.workspace.root)),
                ("Annuler (Git)", "disponible" if sv.snap.available else "indisponible"),
                ("MCP", "; ".join(f"{m['name']}: {m['state']} ({m['tools']})" for m in sv.mcp.status()) or "aucun"),
                ("Skills", ", ".join(sv.ext.skills) or "aucun"),
                ("Plugins", ", ".join(p.name for p in sv.ext.plugins.plugins.values()) or "aucun"),
                ("Fusion", ("activée : " + ", ".join(sv.config.fusion_helpers)) if sv.config.fusion_enabled else "désactivée")]
        return _info("État (/status)", "\n".join(f"{k:18} {v}" for k, v in rows))

    if name == "mcp":
        st = sv.mcp.status()
        return _info("Serveurs MCP", "\n".join(f"{s['name']} : {s['state']} ({s['tools']} outils){' — ' + s['error'] if s['error'] else ''}" for s in st)
                     or "Aucun serveur MCP configuré (voir le README : mcp.json).")

    if name == "skills":
        sk = sv.ext.skills
        if not sk:
            return _info("Skills", "Aucun skill. Ajoutez .eclipse/skills/NOM/SKILL.md (ou .claude/skills, .opencode/skills, ~/.config/eclipse/skills).")
        return _info("Skills (/NOM pour en utiliser un)", "\n".join(f"/{n}  [{s.scope}] {s.description}" for n, s in sk.items()))

    if name == "plugins":
        sub, _, pname = args.partition(" ")
        pname = pname.strip()
        if sub in ("trust", "untrust") and pname:
            p = sv.ext.plugins.plugins.get(pname)
            if not p:
                return _msg(f"Plugin inconnu : {pname}", False)
            if sub == "trust" and not confirmed:
                return {"ok": True, "need_confirm": {"title": f"Approuver le plugin « {pname} » ({p.scope}) ?", "body": p.path.read_text(encoding="utf-8")[:4000],
                                                     "warning": "Ce code s'exécutera avec VOS droits, sans sandbox. Relisez-le. L'approbation est liée à l'empreinte du fichier."}}
            (sv.ext.plugins.trust if sub == "trust" else sv.ext.plugins.untrust)(pname)
            sv.reload_extensions()
            return _msg(f"Plugin « {pname} » approuvé et chargé." if sub == "trust" else f"Approbation retirée pour « {pname} ».", state=True)
        if not sv.ext.plugins.plugins:
            return _info("Plugins", "Aucun plugin. Placez un .py dans .eclipse/plugins/ (API : voir le README).")
        lines = []
        for p in sv.ext.plugins.plugins.values():
            st = "chargé" if p.loaded else (f"erreur : {p.error}" if p.error else ("approuvé" if p.trusted else f"NON approuvé → /plugins trust {p.name}"))
            lines.append(f"{p.name} ({p.scope}) — {st}" + (f" — outils : {', '.join(p.tools)}" if p.tools else ""))
        return _info("Plugins", "\n".join(lines))

    if name == "todo":
        sub, _, rest = args.partition(" ")
        t = sv.ctx.todos
        if sub == "add" and rest.strip():
            t.add(rest.strip())
        elif sub in ("doing", "done") and rest.strip().isdigit():
            t.set_status(int(rest), "in_progress" if sub == "doing" else "done")
        elif sub == "clear":
            t.clear()
        elif sub:
            return _msg("Usage : /todo add TEXTE | doing N | done N | clear", False)
        sv.session.todos = t.to_json()
        sv.session.save()
        items = t.to_json()
        return _info("Todo", "\n".join(f"{i['id']}. [{i['status']}] {i['content']}" for i in items) or "(vide)", state=True)

    if name == "system":
        g = data_dir() / "instructions.md"
        pj = sv.ctx.workspace.root / ".eclipse" / "instructions.md"
        sub, _, rest = args.partition(" ")
        if sub == "set" and rest.strip():
            g.write_text(rest.strip() + "\n", encoding="utf-8")
            return _msg("Consignes globales enregistrées.")
        if sub == "project" and rest.strip():
            pj.parent.mkdir(exist_ok=True)
            pj.write_text(rest.strip() + "\n", encoding="utf-8")
            return _msg("Consignes du projet enregistrées (.eclipse/instructions.md).")
        if sub == "clear":
            (pj if rest.strip() == "project" else g).unlink(missing_ok=True)
            return _msg("Consignes effacées.")
        out = []
        for label, f in (("Globales", g), ("Projet", pj)):
            out.append(f"{label} ({f}) :\n" + (f.read_text(encoding="utf-8").strip() if f.is_file() else "(aucune)"))
        out.append("/system set TEXTE · /system project TEXTE · /system clear [project]")
        return _info("Consignes personnelles", "\n\n".join(out))

    if name == "fusion":
        cfg = sv.config
        sub, _, rest = args.partition(" ")
        rest = rest.strip()

        def commit(m: str, ok: bool = True) -> dict:
            save_config(cfg)
            sv.rebuild_tools()
            return _msg(m, ok, state=True)

        if sub in ("on", "off"):
            cfg.fusion_enabled = sub == "on"
            return commit("Mode fusion " + ("activé" if cfg.fusion_enabled else "désactivé") + "."
                          + (" Aucun assistant : /fusion add ID (ex. /fusion add cli:opencode)." if cfg.fusion_enabled and not cfg.fusion_helpers else ""))
        if sub == "add" and rest:
            h = F.parse_helper(rest)
            if h is None:
                return _msg("Identifiant invalide. Formes : claude · cli:opencode · api:openrouter/modèle", False)
            if rest not in cfg.fusion_helpers:
                cfg.fusion_helpers.append(rest)
            ok, why = F.status(h, cfg)
            return commit(f"Assistant ajouté : {h.label} ({why})", ok)
        if sub in ("remove", "rm") and rest:
            if rest in cfg.fusion_helpers:
                cfg.fusion_helpers.remove(rest)
            return commit(f"Assistant retiré : {rest}")
        if sub == "max" and rest.isdigit():
            cfg.fusion_max_calls = max(1, int(rest))
            return commit(f"Maximum {cfg.fusion_max_calls} consultation(s) par tour.")
        lines = [f"Fusion {'ACTIVÉE' if cfg.fusion_enabled else 'désactivée'} · max {cfg.fusion_max_calls} consultation(s)/tour", ""]
        for hid in cfg.fusion_helpers:
            h = F.parse_helper(hid)
            if h:
                ok, why = F.status(h, cfg)
                lines.append(f"{'[ok]' if ok else '[--]'} {hid}  {h.label}  ({why})")
        det = await asyncio.to_thread(CX.agents, False, False, cfg)
        cands = [d["id"] for d in det if d["installed"] and d["id"] not in cfg.fusion_helpers]
        lines += ["", "Agents installés ajoutables : " + (", ".join(cands) or "aucun"),
                  "/fusion on|off · /fusion add ID · /fusion remove ID · /fusion max N  (ID : claude, cli:opencode, api:openrouter/modèle)"]
        return _info("Mode fusion", "\n".join(lines))

    if name in ("permissions", "bypass"):
        pm = sv.ctx.permissions
        a = args.lower()
        if name == "permissions" and a in ("ask", "edits"):
            pm.set_mode(a)
            return _msg({"ask": "Permissions : tout est confirmé.", "edits": "Permissions : modifications de fichiers du projet acceptées d'office."}[a], state=True)
        if a in ("off", "ask", "non") and name == "bypass":
            pm.set_mode("ask")
            return _msg("Bypass désactivé : retour au mode ask (tout est confirmé).", state=True)
        if name == "permissions" and a not in ("bypass", "all", "total"):
            return _info("Permissions", f"Mode actuel : {pm.mode}{' (TOTAL)' if pm.bypass_all else ''}\n\n/permissions ask · tout confirmer (recommandé)\n"
                         "/permissions edits · modifications de fichiers du projet acceptées d'office\n/bypass · aucune confirmation sauf destructif / hors projet\n"
                         "/bypass all · AUCUNE confirmation\n/bypass off · revenir à ask")
        total = a in ("all", "total")
        if not confirmed:
            return {"ok": True, "need_confirm": {
                "title": "Activer le BYPASS TOTAL ?" if total else "Activer le BYPASS des permissions ?", "body": "",
                "warning": ("Plus AUCUNE confirmation : modifications, commandes, suppressions, accès hors du projet, outils MCP/plugins/skills. " if total else
                            "Plus de confirmation pour les modifications, commandes, outils MCP/plugins/skills. Les actions DESTRUCTRICES et hors du projet "
                            "redemandent confirmation. ") + "Aucune sandbox : tout s'exécute avec vos droits. sudo reste refusé. Non conservé au redémarrage."}}
        pm.set_mode("bypass", bypass_all=total)
        return _msg("BYPASS " + ("TOTAL " if total else "") + "activé — /bypass off pour revenir.", state=True)

    if name == "claude-limit":
        from ..ui.util import parse_duration
        parts = args.split()
        try:
            if parts and parts[0] in ("off", "aucune"):
                sv.budget.clear_envelope("claude")
                return _msg("Limite supprimée.", state=True)
            n = int(parts[0].replace("_", ""))
            period = parse_duration(parts[1]) if len(parts) > 1 else 0
            scope = sv.model_key if sv.is_cli else "claude-code"
            sv.budget.set_envelope(kind="claude", name=scope, amount_points=None, token_limit=n, period_s=period, scope=[scope], on_exhaust="pause", carry_over=False)
            return _msg(f"Limite {sv.mode_label if sv.is_cli else 'Claude'} : {_fmt(n)} tokens" + (f", renouvelée toutes les {parts[1]}" if period else "")
                        + " — pause à épuisement.", state=True)
        except (ValueError, IndexError):
            return _msg("Usage : /limit 200000 [5h] | /limit off", False)

    if name in ("rate", "spent", "define-token"):
        if sv.is_cli:
            return _msg(f"La consommation est gérée par l'abonnement {sv.mode_label} : les budgets en points ne s'appliquent pas. "
                        "Pour une limite de tokens propre à Eclipse : /limit N [période].", False)
        try:
            if name == "rate":
                sv.config.points_per_usd = float(args.replace(",", "."))
                save_config(sv.config)
                return _msg(f"Taux saisi : {sv.config.points_per_usd:g} points/USD", state=True)
            if name == "spent":
                sv.budget.add_manual(sv.session.id, float(args.replace(",", ".")))
                return _msg("Dépense saisie à la main enregistrée [saisi].", state=True)
            from ..ui.util import parse_duration
            parts = args.split()
            if parts and parts[0] in ("off", "clear", "aucun"):
                sv.budget.clear_envelope("temporary")
                return _msg("Budget temporaire supprimé.", state=True)
            pts = float(parts[0].replace(",", "."))
            period = parse_duration(parts[1]) if len(parts) > 1 else 0
            sv.budget.set_envelope(kind="temporary", name="temporaire", amount_points=pts, token_limit=None, period_s=period, scope=["*"],
                                   on_exhaust="pause", carry_over=False)
            return _msg(f"Budget local : {pts:g} points" + (f", renouvelé toutes les {parts[1]}" if period else "") + " — pause à épuisement."
                        + ("" if sv.config.points_per_usd else " Sans taux (/rate N), les dépenses en points restent indisponibles."), state=True)
        except (ValueError, IndexError):
            return _msg({"rate": "Usage : /rate 30000", "spent": "Usage : /spent 12.5",
                         "define-token": "Usage : /define-token POINTS [période, ex. 24h] · /define-token off"}[name], False)

    if name == "reload":
        sv.reload_extensions()
        return _msg(f"Rechargé : {len(sv.ext.skills)} skills, {len(sv.ext.modes)} modes, {len(sv.ext.custom)} commandes, {len(sv.ext.plugins.plugins)} plugins.", state=True)

    if name == "add-dir":
        if not args:
            return _msg("Usage : /add-dir CHEMIN — autorise ce dossier en plus du projet (confirmations habituelles).", False)
        try:
            return _msg(f"Dossier autorisé en plus du projet : {sv.add_dir(args)}", state=True)
        except (NotADirectoryError, FileNotFoundError) as e:
            return _msg(f"Dossier introuvable : {e}", False)

    if name == "verify":
        if not args.isdigit():
            return _msg("Usage : /verify ID_RÉSUMÉ", False)
        from ..memory.compaction import verify_summary
        r = verify_summary(sv.memory, int(args))
        return _msg(f"summary:{args} : {'OK' if r.ok else 'PROBLÈMES : ' + '; '.join(r.problems)} ({r.checked_archives} archives contrôlées)", r.ok)

    if name == "free":
        from ..free import sources
        srcs = await sources()
        return _info("Modèles gratuits (/free)", "\n\n".join(f"{'[ok]' if s.ready else '[--]'} {s.label} — {s.status}\n    {s.how}\n    {s.tradeoff}" for s in srcs))

    if name == "init":
        if hub.busy:
            return _msg("Une réponse est déjà en cours.", False)
        hub.turn = asyncio.get_running_loop().create_task(hub.run_turn(INIT_PROMPT))
        return {"ok": True, "turn": True, "shown": "/init"}

    if name == "detect":
        det = await asyncio.to_thread(CX.agents, True, True, sv.config)
        lines = [f"[ok] {d['label']:20} {d['path']}  {d['version'] or d['version_error']}  (via {d['source']})" if d["installed"]
                 else f"[--] {d['label']:20} non installé — {d['reason']}" for d in det]
        return _info("Agents détectés", "\n".join(lines) + "\n\nChemin manuel : /agent-path ID CHEMIN, ou Connexions.", state=True)

    if name == "agent-path":
        aid, _, path = args.partition(" ")
        if not aid:
            return _msg("Usage : /agent-path ID CHEMIN (vide : détection automatique)", False)
        ok, m, _ = await asyncio.to_thread(CX.set_agent_path, aid, path, sv.config)
        return _msg(m, ok, state=True)

    if name == "disconnect":
        if not args:
            return _msg("Usage : /disconnect ID (ex. openrouter). Les clés en variable d'environnement ne sont pas touchées.", False)
        ok, m = CX.forget_key(args)
        return _msg(m, ok, state=True)

    if name == "options":
        params = sv.model_params()
        if not params:
            return _info("Réglages du modèle", f"{hub.current_model() or sv.mode_label} n'expose aucun réglage.")
        if args:
            pname, _, raw = args.partition(" ")
            p = next((x for x in params if x.name == pname), None)
            if p is None:
                return _msg(f"Réglage inconnu : {pname}", False)
            try:
                sv.set_option(p.name, variants.coerce(p, raw) if raw.strip() else None)
            except ValueError as e:
                return _msg(f"Valeur refusée : {e}", False)
            return _msg(f"{p.name} → {raw.strip() or 'défaut'}", state=True)
        cur = sv.current_options()
        lines = [f"{p.name:18} = {json.dumps(cur[p.name], ensure_ascii=False) if p.name in cur else '(défaut)'}   "
                 f"[{p.kind}{': ' + ', '.join(map(str, p.choices)) if p.choices else ''}] {p.description or ''}" for p in params]
        return _info("Réglages du modèle (/options NOM VALEUR)", "\n".join(lines))

    if name in ("provider", "agents"):
        if name == "agents":
            if not args:
                return _info("Modes", "\n".join(f"{n}{' (sous-agent)' if not m.primary else ''} — {m.description}" for n, m in sv.ext.modes.items())
                             + "\n\n/mode NOM pour changer")
            warn = sv.set_agent(args) if args in sv.ext.modes else None
            return _msg(f"Mode → {args}" + (f" ({warn})" if warn else ""), args in sv.ext.modes, state=True)
        if not args:
            return {"ok": True, "open": "connections"}
        target = args if args == "claude" or ":" in args else (f"cli:{args}" if get_adapter(args) else f"api:{args}")
        ok, m = await hub.connect(target, None)
        if m == "need_key":
            return {"ok": False, "open": "connections", "message": "Clé d'API à saisir dans Connexions."}
        if ok and not sv.is_cli:
            await sv.load_models()
        return _msg(m, ok, state=True)

    if name == "effort":
        sub, _, rest = args.partition(" ")
        if sub.lower() in ("par-defaut", "par-défaut", "pardefaut"):
            from ..config import Config
            try:
                sv.config.default_effort = Config(default_effort=rest.strip() or "défaut").default_effort
            except Exception:  # noqa: BLE001
                return _msg("Niveau par défaut : défaut, rapide, normal ou profond.", False)
            save_config(sv.config)
            return _msg(f"Effort par défaut → {sv.config.default_effort}", state=True)
        p = variants.effort_param(sv.model_params())
        if p is None:
            return _msg("Ce modèle ne propose pas de réglage d'effort.", False)
        if not args:
            cur = sv.current_options().get(p.name)
            return _info("Effort", f"{p.name} = {cur if cur is not None else 'défaut'} ({variants.level_of(p, cur) or '-'})\n"
                         f"Niveaux : " + ", ".join(f"{lv} → {variants.level_value(p, lv)}" for lv in variants.LEVELS)
                         + f"\nValeurs du modèle : {', '.join(map(str, p.choices))}\nPar défaut (toutes conversations) : {sv.config.default_effort}"
                         "\n\n/effort rapide|normal|profond|défaut|VALEUR · /effort par-defaut NIVEAU")
        a = args.lower()
        try:
            val = None if a in ("défaut", "default") else (variants.level_value(p, a) if a in variants.LEVEL_ALIASES else variants.coerce(p, args))
        except ValueError as e:
            return _msg(f"Valeur invalide : {e} · ou rapide, normal, profond", False)
        sv.set_option(p.name, val)
        return _msg(f"Effort ({p.name}) → {val if val is not None else 'défaut'}", state=True)

    return _msg(f"Commande inconnue : /{name}", False)
