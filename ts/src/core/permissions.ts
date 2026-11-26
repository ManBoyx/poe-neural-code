/**
 * Permissions des outils. Modes :
 *  - « demander »      : lecture libre dans le projet ; écriture et commandes confirmées une par une ;
 *  - « modifications » : écritures dans le projet acceptées d'office, commandes confirmées ;
 *  - « lecture »       : lecture seule, toute écriture ou commande refusée ;
 *  - « bypass »        : plus de confirmation, sauf actions destructrices ou hors du projet ;
 *  - « bypass total »  : aucune confirmation.
 * Le bypass n'est activé qu'après vérification du mot de passe de l'ordinateur par le système (polkit) ;
 * il dure jusqu'à la fermeture d'Eclipse.
 */
export type PermMode = "demander" | "modifications" | "lecture" | "bypass" | "bypass-total"

export const PERM_LABEL: Record<PermMode, string> = {
  demander: "tout confirmer (recommandé)",
  modifications: "modifications du projet acceptées d'office, commandes confirmées",
  lecture: "lecture seule : aucune écriture ni commande",
  bypass: "aucune confirmation, sauf destructif ou hors du projet (mot de passe demandé)",
  "bypass-total": "AUCUNE confirmation, même destructive ou hors du projet (mot de passe demandé)",
}

export interface Request {
  tool: string
  kind: "read" | "write" | "exec"
  summary: string
  detail?: string // diff ou commande complète
  outside?: boolean
  destructive?: boolean
  grantKey: string // « toujours pour cette session »
  mustRead?: boolean // « autoriser » seulement après avoir affiché tout le détail (approbation d'un serveur MCP de projet)
}

export type Decision = "once" | "session" | "deny"

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, /\bsudo\b/, /\bdoas\b/, /\bmkfs/, /\bdd\s+if=/, /\bshred\b/, /\bwipefs\b/, />\s*\/dev\/sd/,
  /\bgit\s+push\b.*(--force|-f\b)/, /\bgit\s+reset\s+--hard/, /\bgit\s+clean\s+-[a-z]*f/, /\bchmod\s+-R\s+777/, /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
]

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE.some((r) => r.test(command))
}

export class Permissions {
  mode: PermMode = "demander"
  bypassVerified = false
  grants = new Set<string>()
  log: { tool: string; summary: string; decision: string }[] = []

  constructor(public ask: (r: Request) => Promise<Decision>) {}

  setMode(m: PermMode): void {
    if ((m === "bypass" || m === "bypass-total") && !this.bypassVerified) throw new Error("bypass non vérifié")
    this.mode = m
  }

  /** Décide sans demander quand c'est possible ; sinon pose la question. Renvoie true si l'action est permise. */
  async authorize(r: Request): Promise<boolean> {
    const done = (d: string, ok: boolean) => (this.log.push({ tool: r.tool, summary: r.summary, decision: d }), ok)
    if (r.kind === "read" && !r.outside) return done("lecture", true)
    if (this.mode === "lecture" && r.kind !== "read") return done("refusé (lecture seule)", false)
    if (this.mode === "bypass-total") return done("bypass total", true)
    if (this.mode === "bypass" && !r.destructive && !r.outside) return done("bypass", true)
    const sticky = !r.destructive && !r.outside
    if (sticky && this.grants.has(r.grantKey)) return done("session", true)
    if (this.mode === "modifications" && r.kind === "write" && !r.outside) return done("modifications auto", true)
    const d = await this.ask(r)
    if (d === "session" && sticky) this.grants.add(r.grantKey)
    return done(d, d !== "deny")
  }
}
