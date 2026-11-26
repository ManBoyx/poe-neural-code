/**
 * Sandbox (bac à sable), activée par défaut. Sous Linux, les commandes lancées par les modèles tournent dans
 * bubblewrap : tout le système est en lecture seule, sauf le projet (et les dossiers ajoutés), un /tmp privé et les
 * caches des outils de build. Le réseau reste disponible (installations de paquets, tests qui appellent une API).
 * Les agents utilisent leur propre sandbox (Claude Code : sandbox.enabled ; Codex : sandbox_mode) ; ceux qui n'en
 * ont pas d'utilisable ici (Gemini sans Docker, OpenCode) sont enveloppés entiers dans bubblewrap, avec leur dossier
 * de réglages accessible en écriture.
 * Le bypass ne désactive pas la sandbox : il ne fait que supprimer les confirmations.
 * Sandbox coupée ou non, les fichiers d'Eclipse sont toujours en lecture seule pour ces processus (voir guard).
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { home } from "./paths"
import { guardPaths } from "./protect"

export function available(): { ok: true; tool: string } | { ok: false; reason: string } {
  if (process.platform !== "linux") return { ok: false, reason: "sandbox disponible seulement sous Linux dans cette version" }
  const b = Bun.which("bwrap")
  return b ? { ok: true, tool: "bubblewrap" } : { ok: false, reason: "bubblewrap (bwrap) n'est pas installé" }
}

const CACHES = [".cache", ".npm", ".bun/install/cache", ".cargo/registry", ".cargo/git", ".local/share/pnpm", ".gradle", ".m2", "go/pkg"]

// Pas de --new-session : les processus sont déjà lancés dans leur propre session, sans terminal de contrôle
// (Bun.spawn detached) ; garder le même groupe permet d'arrêter tout l'arbre d'un coup (killGroup), sans orphelin.

/** Enveloppe une commande dans bubblewrap ; `writable` : dossiers accessibles en écriture en plus des caches. */
export function wrap(cmd: string[], writable: string[], cwd: string): string[] {
  const b = Bun.which("bwrap") ?? "bwrap"
  const args = [b, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--die-with-parent"]
  const seen = new Set<string>()
  for (const d of [...writable, ...CACHES.map((c) => join(home(), c))]) {
    if (!d || seen.has(d) || !existsSync(d)) continue
    seen.add(d)
    args.push("--bind", d, d)
  }
  // les fichiers d'Eclipse restent en lecture seule, même si un dossier ajouté les contient
  for (const p of guardPaths()) args.push("--ro-bind", p, p)
  args.push("--chdir", cwd, "--", ...cmd)
  return args
}

/**
 * Garde, appliquée quand la sandbox est coupée (et en bypass) : le processus garde tous ses droits habituels, sauf
 * sur les fichiers d'Eclipse, montés en lecture seule. Les sandbox propres aux agents fonctionnent à l'intérieur.
 * Sans bubblewrap, la commande est lancée telle quelle (seuls les outils d'Eclipse refusent alors d'y écrire).
 */
export function guard(cmd: string[], cwd: string): string[] {
  const b = process.platform === "linux" ? Bun.which("bwrap") : null
  if (!b) return cmd
  const args = [b, "--dev-bind", "/", "/"]
  for (const p of guardPaths()) args.push("--ro-bind", p, p)
  args.push("--die-with-parent", "--chdir", cwd, "--", ...cmd)
  return args
}

/** Dossiers de réglages qu'un agent doit pouvoir écrire (sessions, connexion). */
export function agentStateDirs(agent: string): string[] {
  const h = home()
  return ({
    claude: [join(h, ".claude"), join(h, ".claude.json")],
    codex: [join(h, ".codex")],
    gemini: [join(h, ".gemini")],
    opencode: [join(h, ".local/share/opencode"), join(h, ".config/opencode"), join(h, ".opencode")],
  } as Record<string, string[]>)[agent] ?? []
}
