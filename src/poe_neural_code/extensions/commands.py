"""Registre des commandes slash : toutes celles d'OpenCode + celles d'Eclipse, personnalisées, de skills et de plugins.

Commandes OpenCode (doc officielle) : connect, compact (/summarize), editor, exit (/quit /q), export, help, init, models, new (/clear),
redo, sessions (/resume /continue), themes, thinking, undo, update. Raccourcis : leader Ctrl+X puis la lettre indiquée.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .frontmatter import parse


@dataclass
class Command:
    name: str
    description: str
    aliases: tuple[str, ...] = ()
    keybind: str = ""
    kind: str = "builtin"  # builtin | custom | skill | plugin
    template: str = ""
    agent: str | None = None
    model: str | None = None
    usage: str = ""


B = Command
BUILTINS: list[Command] = [
    # --- celles d'OpenCode ---
    B("connect", "Connecter un fournisseur (clé d'API) ou un agent IA installé (Claude Code, OpenCode, Gemini CLI, Codex, Kiro…)", keybind=""),
    B("disconnect", "Oublier la clé d'un fournisseur : /disconnect ID", usage="/disconnect ID"),
    B("compact", "Compacter la session (résumé vérifiable, archives conservées)", ("summarize",), "ctrl+x c"),
    B("editor", "Rédiger le message dans l'éditeur externe ($EDITOR)", keybind="ctrl+x e"),
    B("exit", "Quitter Eclipse", ("quit", "q"), "ctrl+x q"),
    B("export", "Exporter la conversation en Markdown et l'ouvrir dans l'éditeur", keybind="ctrl+x x"),
    B("help", "Aide : commandes et raccourcis"),
    B("init", "Créer ou mettre à jour AGENTS.md (configuration guidée par l'agent)"),
    B("models", "Choisir le modèle (et ses réglages)", keybind="ctrl+x m"),
    B("model", "Choisir directement un modèle : /model NOM", usage="/model NOM"),
    B("new", "Nouvelle session", ("clear",), "ctrl+x n"),
    B("redo", "Rétablir le message annulé (et les fichiers, via Git)", keybind="ctrl+x r"),
    B("sessions", "Lister/changer de session", ("resume", "continue"), "ctrl+x l"),
    B("themes", "Choisir le thème", keybind="ctrl+x t"),
    B("thinking", "Afficher/masquer les blocs de réflexion du modèle"),
    B("undo", "Annuler le dernier message (réponses et fichiers modifiés, via Git)", keybind="ctrl+x u"),
    B("update", "Vérifier les versions (Eclipse, Claude Code)"),
    # --- propres à Eclipse ---
    B("agents", "Choisir le mode/agent (build, plan, personnalisés)", ("modes",), "ctrl+x a"),
    B("mode", "Changer de mode : /mode NOM", usage="/mode build|plan|NOM"),
    B("provider", "Changer de fournisseur ou d'agent : /provider ID (poe, openrouter, claude, opencode…)", usage="/provider ID"),
    B("fusion", "Mode fusion : le modèle actif peut consulter d'autres modèles/agents disponibles (ex. Claude Code → Kiro, OpenCode, une API)", usage="/fusion [on|off|list|add ID|remove ID]"),
    B("effort", "Niveau d'effort/raisonnement du modèle actif (Ctrl+T pour alterner)", ("variant",), "ctrl+t", usage="/effort [niveau|défaut]"),
    B("permissions", "Modes de permission : ask (tout confirmer) · edits (modifications acceptées) · bypass (aucune confirmation)", ("perm",), "ctrl+x p", usage="/permissions ask|edits|bypass"),
    B("bypass", "Bypass permissions : plus aucune confirmation (confirmation requise pour l'activer) ; /bypass off pour revenir", usage="/bypass [on|all|off]"),
    B("options", "Tous les réglages du modèle actif (effort, recherche web, réflexion…)", ("params",), usage="/options"),
    B("usage", "Consommation détaillée : barres, période, par modèle/agent, fenêtres Claude", ("cost",), "ctrl+x i"),
    B("status", "État : fournisseur, MCP, budget, extensions", keybind="ctrl+x s"),
    B("sidebar", "Afficher/masquer la barre latérale", keybind="ctrl+x b"),
    B("details", "Afficher/masquer le détail des sorties d'outils", keybind="ctrl+x h"),
    B("timeline", "Aller à un message de la session", keybind="ctrl+x g"),
    B("copy", "Copier la dernière réponse", keybind="ctrl+x y"),
    B("rename", "Renommer la session", keybind="ctrl+r", usage="/rename TITRE"),
    B("skills", "Lister les skills (catalogue chargé à la demande)", usage="/skills"),
    B("plugins", "Plugins : /plugins, /plugins trust NOM, /plugins untrust NOM", usage="/plugins [trust|untrust NOM]"),
    B("mcp", "État des serveurs MCP"),
    B("memory", "Rechercher dans la mémoire du projet", usage="/memory REQUÊTE"),
    B("verify", "Vérifier un résumé contre ses sources", usage="/verify ID"),
    B("todo", "Todo : add TEXTE | doing N | done N | clear", usage="/todo add|doing|done|clear"),
    B("define-token", "Budget local (points / tokens, période, portée, épuisement, report)"),
    B("claude-limit", "Limite de tokens de l'agent/fournisseur actif : /limit N [5h] | off", ("limit",), usage="/limit 200000 5h"),
    B("rate", "Taux points/USD saisi à la main", usage="/rate N"),
    B("spent", "Dépense saisie à la main (points)", usage="/spent N"),
    B("reload", "Recharger skills, modes, plugins et commandes personnalisées"),
    # --- 0.2.0 ---
    B("free", "Modèles GRATUITS : OpenCode (sans compte), OpenRouter :free, Ollama local, offres gratuites par clé"),
    B("retry", "Relancer le dernier message (annule la réponse et les fichiers, puis renvoie)", ("regenerate",)),
    B("edit", "Modifier le dernier message (l'annule et le remet dans la saisie)"),
    B("fork", "Dupliquer la session (branche de conversation indépendante)"),
    B("add-dir", "Autoriser un dossier en plus du projet : /add-dir CHEMIN", usage="/add-dir CHEMIN"),
    B("system", "Consignes personnelles : /system (voir) · /system set TEXTE · /system project TEXTE · /system clear [project]", ("instructions",)),
    B("config", "Tous les réglages d'Eclipse", ("settings",)),
    B("doctor", "Diagnostic : installation, clés, réseau, agents, MCP"),
    B("context", "Ce qui occupe le contexte du modèle (prompt système, mémoire, historique, outils)"),
    B("diff", "Modifications en cours du dépôt Git (git diff)"),
    B("login", "Se connecter à un fournisseur (= /connect)"),
    B("logout", "Oublier la clé d'un fournisseur (= /disconnect)", usage="/logout ID"),
    B("attach", "Joindre une image ou un fichier : /attach CHEMIN (ou @chemin dans le message)", usage="/attach CHEMIN"),
]

# Commandes « prompt » intégrées (remplaçables par une commande personnalisée du même nom)
PROMPTS: list[Command] = [
    Command("review", "Relecture des modifications en cours (bugs, régressions, tests manquants)", kind="custom",
            template="Relis les modifications en cours du dépôt (git status, git diff). Signale les bugs, régressions et tests manquants par ordre de gravité, "
                     "avec fichier et ligne. Ne modifie rien. $ARGUMENTS", agent="plan"),
    Command("explain", "Expliquer un fichier, une fonction ou un concept", kind="custom",
            template="Explique $ARGUMENTS : rôle, fonctionnement, dépendances et points d'attention. Lis les fichiers concernés avant de répondre."),
    Command("tests", "Écrire ou compléter des tests puis les exécuter", kind="custom",
            template="Écris ou complète les tests pour $ARGUMENTS en suivant les conventions du projet, puis exécute-les et corrige ce qui échoue."),
    Command("fix", "Diagnostiquer et corriger une erreur", kind="custom",
            template="Voici une erreur ou un symptôme : $ARGUMENTS\nTrouve la cause (lis le code, reproduis si possible), corrige-la, puis vérifie avec les tests."),
    Command("commit", "Préparer un commit (message proposé, commit après accord)", kind="custom",
            template="Examine git status et git diff, propose un message de commit clair (style conventionnel), puis crée le commit avec run_command. $ARGUMENTS"),
    Command("plan", "Planifier une tâche sans rien modifier", kind="custom", agent="plan",
            template="Établis un plan détaillé, étape par étape, pour : $ARGUMENTS\nLis le code nécessaire, note les risques, et alimente la todo list. Ne modifie rien."),
]


def _load_md_commands(base: Path, out: dict[str, Command]) -> None:
    if not base.is_dir():
        return
    for f in sorted(base.rglob("*.md")):
        name = str(f.relative_to(base).with_suffix("")).replace("\\", "/")
        if name in out:
            continue
        try:
            fields, body, _ = parse(f.read_text(encoding="utf-8"))
        except OSError:
            continue
        out[name] = Command(name, fields.get("description") or body.splitlines()[0][:70] if body else "", kind="custom", template=body,
                            agent=fields.get("agent"), model=fields.get("model"), usage=f"/{name} [arguments]")


def custom_commands(root: Path, home: Path | None = None) -> dict[str, Command]:
    """Commandes personnalisées : .eclipse/commands, .opencode/commands, .claude/commands (+ globaux). Le projet prime."""
    home = home or Path.home()
    out: dict[str, Command] = {}
    for d in (".eclipse/commands", ".opencode/commands", ".opencode/command", ".claude/commands"):
        _load_md_commands(root / d, out)
    for d in ("~/.config/eclipse/commands", "~/.config/opencode/commands", "~/.claude/commands"):
        _load_md_commands(Path(d.replace("~", str(home), 1)), out)
    return out


def expand_template(template: str, args: str) -> str:
    """$ARGUMENTS = tout ; $1…$9 = arguments positionnels."""
    parts = args.split()
    out = template.replace("$ARGUMENTS", args)
    for i in range(9, 0, -1):
        out = out.replace(f"${i}", parts[i - 1] if len(parts) >= i else "")
    return out


def all_commands(custom: dict[str, Command] | None = None, skills=None, plugin_commands=None) -> list[Command]:
    cmds = list(BUILTINS)
    taken = {c.name for c in cmds} | {a for c in cmds for a in c.aliases}
    for c in PROMPTS:  # une commande personnalisée du même nom remplace le prompt intégré
        if c.name not in (custom or {}) and c.name not in taken:
            cmds.append(c)
            taken.add(c.name)
    for name, c in (custom or {}).items():
        if name not in taken:
            cmds.append(c)
            taken.add(name)
    for name, s in (skills or {}).items():
        if name not in taken:
            cmds.append(Command(name, f"[skill] {s.description}"[:90], kind="skill", usage=f"/{name} [demande]"))
            taken.add(name)
    for name, (plugin, desc, _h) in (plugin_commands or {}).items():
        if name not in taken:
            cmds.append(Command(name, f"[plugin {plugin}] {desc}", kind="plugin"))
            taken.add(name)
    return cmds


def resolve(name: str, cmds: list[Command]) -> Command | None:
    n = name.lower()
    for c in cmds:
        if c.name.lower() == n or n in c.aliases:
            return c
    return None


def preview(prefix: str, cmds: list[Command], limit: int = 12) -> list[Command]:
    """Aperçu affiché pendant la frappe de « /… » : commandes dont le nom ou un alias commence/contient le texte."""
    p = prefix.lstrip("/").lower()
    starts = [c for c in cmds if c.name.startswith(p) or any(a.startswith(p) for a in c.aliases)]
    rest = [c for c in cmds if c not in starts and (p in c.name or p in c.description.lower())]
    return (starts + rest)[:limit]
