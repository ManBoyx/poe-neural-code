/**
 * Catalogue des commandes « / » : toutes celles de l'ancien Eclipse (Python 4.0) et toutes celles d'OpenCode 2.4.1,
 * sans doublon. Une commande présente des deux côtés n'apparaît qu'une fois ; les autres noms deviennent des alias.
 * Conflit de sens : `/thinking` (OpenCode : changer l'effort ; Eclipse : afficher la réflexion) garde le sens d'Eclipse,
 * l'effort ayant déjà `/effort`.
 *
 * `ready` : la commande marche dans cette version. Sinon `step` dit à quelle étape du plan elle arrive :
 * elle reste listée (rien n'est caché), et l'aide l'indique.
 */
export interface Command {
  name: string
  aliases?: string[]
  desc: string
  usage?: string
  keys?: string
  origin: "eclipse" | "opencode" | "les deux"
  ready: boolean
  step?: string
}

const S = { sessions: "sessions enregistrées", tools: "outils et permissions", agents: "agents CLI", cg: "/cg", mem: "mémoire", budget: "budget", mcp: "MCP" }

export const COMMANDS: Command[] = [
  // --- connexions, fournisseurs, modèles
  { name: "connect", aliases: ["login", "auth"], desc: "Connexions : saisir ou changer une clé d'API", origin: "les deux", ready: true },
  { name: "disconnect", aliases: ["logout"], desc: "Oublier la clé d'un fournisseur", usage: "/disconnect ID", origin: "eclipse", ready: true },
  { name: "provider", desc: "Choisir le fournisseur ou l'agent", usage: "/provider [ID]", origin: "eclipse", ready: true },
  { name: "models", desc: "Choisir le modèle", keys: "ctrl+x m", origin: "les deux", ready: true },
  { name: "model", desc: "Choisir directement un modèle", usage: "/model NOM", origin: "eclipse", ready: true },
  { name: "effort", aliases: ["variant"], desc: "Effort du modèle : rapide, normal, profond", usage: "/effort [rapide|normal|profond|défaut]", keys: "ctrl+t", origin: "les deux", ready: true },
  { name: "options", aliases: ["params"], desc: "Tous les réglages du modèle actif", origin: "eclipse", ready: true },
  { name: "power", aliases: ["puissance"], desc: "Puissance de l'agent : lecture, modifications, commandes", usage: "/power lecture|modifications|commandes", origin: "eclipse", ready: true },
  { name: "free", desc: "Modèles gratuits disponibles", origin: "eclipse", ready: true },
  { name: "detect", desc: "Détecter à nouveau les agents installés", origin: "eclipse", ready: true },
  { name: "agent-path", desc: "Indiquer à la main l'exécutable d'un agent", usage: "/agent-path ID [CHEMIN]", origin: "eclipse", ready: true },
  { name: "fusion", desc: "Le modèle actif peut consulter d'autres modèles ou agents", usage: "/fusion [on|off|list|add ID|remove ID]", origin: "eclipse", ready: true },
  { name: "cg", desc: "Discussion commune Claude Code et Codex : un écrit, l'autre relit, un seul résultat", usage: "/cg [off | lead claude|codex]", origin: "eclipse", ready: true },
  // --- session et conversation
  { name: "new", aliases: ["clear"], desc: "Nouvelle discussion", keys: "ctrl+x n", origin: "les deux", ready: true },
  { name: "sessions", aliases: ["resume", "continue"], desc: "Lister et reprendre une session", keys: "ctrl+x l", origin: "les deux", ready: true },
  { name: "open", aliases: ["project", "projects"], desc: "Ouvrir une session ou un projet", origin: "opencode", ready: true },
  { name: "cd", desc: "Changer de dossier de travail", usage: "/cd CHEMIN", origin: "opencode", ready: true },
  { name: "projet", desc: "Créer ou reprendre un projet (un dossier par projet dans ~/Projets)", usage: "/projet [NOM]", origin: "eclipse", ready: true },
  { name: "rename", desc: "Renommer la session", usage: "/rename TITRE", keys: "ctrl+r", origin: "eclipse", ready: true },
  { name: "fork", desc: "Dupliquer la session (branche indépendante)", origin: "eclipse", ready: true },
  { name: "retry", aliases: ["regenerate"], desc: "Relancer le dernier message", origin: "eclipse", ready: true },
  { name: "edit", desc: "Modifier le dernier message (le remet dans la saisie)", origin: "eclipse", ready: true },
  { name: "btw", desc: "Réponse ponctuelle, sans l'ajouter à la discussion", usage: "/btw QUESTION", origin: "opencode", ready: true },
  { name: "undo", desc: "Annuler le dernier message (réponses et fichiers)", keys: "ctrl+x u", origin: "eclipse", ready: true },
  { name: "redo", desc: "Rétablir le message annulé", keys: "ctrl+x r", origin: "eclipse", ready: true },
  { name: "compact", aliases: ["summarize"], desc: "Compacter la session (résumé vérifiable)", keys: "ctrl+x c", origin: "eclipse", ready: true },
  { name: "export", desc: "Exporter la discussion en Markdown", keys: "ctrl+x x", origin: "eclipse", ready: true },
  { name: "copy", desc: "Copier la dernière réponse", keys: "ctrl+x y", origin: "eclipse", ready: true },
  { name: "timeline", desc: "Aller à un message de la discussion", keys: "ctrl+x g", origin: "eclipse", ready: true },
  { name: "goal", desc: "Continuer jusqu'à atteindre un objectif", usage: "/goal OBJECTIF | pause | resume | clear", origin: "opencode", ready: true },
  { name: "automation", desc: "Message répété (tant qu'Eclipse est ouvert) : add 30m TEXTE | list | pause N | resume N | delete N", origin: "opencode", ready: true },
  { name: "review", desc: "Relire les changements (commit, branche, PR ; défaut : non commités)", usage: "/review [commit|branch|pr]", origin: "opencode", ready: true },
  { name: "attach", desc: "Joindre une image ou un fichier (ou @chemin dans le message)", usage: "/attach CHEMIN", origin: "eclipse", ready: true },
  // --- modes, permissions
  { name: "agents", aliases: ["modes"], desc: "Choisir le mode (build, plan, personnalisés)", keys: "maj+tab", origin: "les deux", ready: true },
  { name: "mode", desc: "Changer de mode", usage: "/mode build|plan|NOM", origin: "eclipse", ready: true },
  { name: "permissions", aliases: ["perm"], desc: "Permissions : demander, modifications, lecture seule, bypass (mot de passe de l'ordinateur)", keys: "ctrl+x p", origin: "eclipse", ready: true },
  { name: "bypass", desc: "Plus aucune confirmation (mot de passe de l'ordinateur demandé)", usage: "/bypass [on|all|off]", origin: "eclipse", ready: true },
  { name: "sandbox", desc: "Sandbox des commandes et des agents : activer ou désactiver (active par défaut)", usage: "/sandbox [on|off]", origin: "eclipse", ready: true },
  { name: "add-dir", desc: "Autoriser un dossier en plus du projet", usage: "/add-dir CHEMIN", origin: "eclipse", ready: true },
  // --- mémoire, instructions, contexte
  { name: "memory", desc: "Mémoire du projet : voir, chercher, ajouter, épingler, oublier", usage: "/memory [REQUÊTE] | add TEXTE | pin N | forget N", origin: "eclipse", ready: true },
  { name: "verify", desc: "Vérifier un résumé contre ses sources", usage: "/verify ID", origin: "eclipse", ready: true },
  { name: "system", aliases: ["instructions"], desc: "Consignes personnelles et du projet", origin: "eclipse", ready: true },
  { name: "init", desc: "Créer ou mettre à jour AGENTS.md (guidé)", origin: "les deux", ready: true },
  { name: "context", desc: "Ce qui est envoyé au modèle (consignes, mémoire, historique)", origin: "eclipse", ready: true },
  { name: "todo", desc: "Tâches : add TEXTE | doing N | done N | clear", usage: "/todo add|doing|done|clear", origin: "eclipse", ready: true },
  // --- consommation et budget
  { name: "usage", aliases: ["cost", "stats"], desc: "Consommation de la session (tokens mesurés par le fournisseur)", keys: "ctrl+x i", origin: "les deux", ready: true },
  { name: "define-token", desc: "Budget local (points, tokens, période)", origin: "eclipse", ready: true },
  { name: "limit", aliases: ["claude-limit"], desc: "Limite de tokens du fournisseur ou de l'agent actif", usage: "/limit N [5h] | off", origin: "eclipse", ready: true },
  { name: "rate", desc: "Taux points / USD saisi à la main", usage: "/rate N", origin: "eclipse", ready: true },
  { name: "spent", desc: "Dépense saisie à la main (points)", usage: "/spent N", origin: "eclipse", ready: true },
  // --- extensions
  { name: "skills", desc: "Lister les skills", origin: "les deux", ready: true },
  { name: "plugins", desc: "Plugins et confiance", usage: "/plugins [trust|untrust NOM]", origin: "les deux", ready: true },
  { name: "mcp", aliases: ["mcps"], desc: "Serveurs MCP", origin: "les deux", ready: true },
  { name: "reload", desc: "Recharger configuration, skills, modes et plugins", origin: "les deux", ready: true },
  // --- affichage
  { name: "themes", desc: "Choisir le thème (dont contraste élevé et sans couleur)", keys: "ctrl+x t", origin: "les deux", ready: true },
  { name: "language", aliases: ["langue", "lang"], desc: "Langue de l'interface (français, anglais)", usage: "/language fr|en", origin: "eclipse", ready: true },
  { name: "thinking", desc: "Afficher ou masquer la réflexion du modèle", origin: "les deux", ready: true },
  { name: "details", desc: "Afficher ou masquer le détail des sorties d'outils", keys: "ctrl+x h", origin: "eclipse", ready: true },
  { name: "sidebar", desc: "Afficher ou masquer la barre latérale", keys: "ctrl+x b", origin: "eclipse", ready: true },
  { name: "editor", desc: "Rédiger le message dans l'éditeur externe ($EDITOR)", keys: "ctrl+x e", origin: "les deux", ready: true },
  { name: "diff", desc: "Modifications en cours du dépôt Git", origin: "les deux", ready: true },
  // --- application
  { name: "settings", aliases: ["config"], desc: "Tous les réglages d'Eclipse", origin: "les deux", ready: true },
  { name: "status", desc: "État : fournisseur, clé, modèle, agents", keys: "ctrl+x s", origin: "les deux", ready: true },
  { name: "doctor", aliases: ["debug"], desc: "Diagnostic : installation, clés, réseau, agents", origin: "les deux", ready: true },
  { name: "update", desc: "Vérifier les versions (Eclipse, agents)", origin: "les deux", ready: true },
  { name: "highlights", desc: "Nouveautés de cette version", origin: "opencode", ready: true },
  { name: "restart", desc: "Redémarrer Eclipse", origin: "opencode", ready: true },
  { name: "pair", desc: "Associer un appareil (appli Android)", origin: "opencode", ready: false, step: "bascule" },
  { name: "help", desc: "Aide : commandes et raccourcis", origin: "les deux", ready: true },
  { name: "exit", aliases: ["quit", "q"], desc: "Quitter Eclipse", keys: "ctrl+c ×2", origin: "les deux", ready: true },
]

export function resolve(name: string): Command | undefined {
  const n = name.toLowerCase()
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n))
}

/** Suggestions pendant la frappe : nom puis alias, commandes prêtes d'abord. */
export function suggest(prefix: string, limit = 10): Command[] {
  const p = prefix.toLowerCase()
  // ordre : nom qui commence par la saisie, puis alias qui commence par elle, puis la saisie ailleurs (nom, alias, description)
  const byName = COMMANDS.filter((c) => c.name.startsWith(p))
  const byAlias = COMMANDS.filter((c) => !byName.includes(c) && c.aliases?.some((a) => a.startsWith(p)))
  const rest = p ? COMMANDS.filter((c) => !byName.includes(c) && !byAlias.includes(c) && (c.name.includes(p) || c.aliases?.some((a) => a.includes(p)) || c.desc.toLowerCase().includes(p))) : []
  const order = (xs: Command[]) => xs.sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.length - b.name.length || a.name.localeCompare(b.name))
  return [...order(byName), ...order(byAlias), ...order(rest)].slice(0, limit)
}
