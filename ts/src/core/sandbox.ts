/**
 * Sandbox (bac à sable), activée par défaut. Sous Linux, les commandes lancées par les modèles tournent dans
 * bubblewrap : tout le système est en lecture seule, sauf le projet (et les dossiers ajoutés), un /tmp privé et les
 * caches des outils de build. Le réseau reste disponible (installations de paquets, tests qui appellent une API).
 * Codex utilise sa propre sandbox (sandbox_mode). Les autres agents (Claude Code, dont la sandbox exige socat, Gemini
 * sans Docker, OpenCode) sont enveloppés entiers dans bubblewrap, avec leur dossier de réglages accessible en écriture.
 * Le bypass force la sandbox (tout est permis, mais dans le projet) ; le bypass total la retire.
 * Partout, sudo et les autres programmes « setuid » ne peuvent pas obtenir de droits root (no_new_privs).
 * Sandbox coupée ou non, les fichiers d'Eclipse sont toujours en lecture seule pour ces processus (voir guard).
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { home } from "./paths"
import { guardPaths } from "./protect"

/**
 * Sandbox effective selon les permissions : le bypass autorise tout DANS le projet, donc les commandes et les agents y
 * sont toujours enfermés (même si /sandbox est coupée) ; le bypass total autorise tout sur le PC, donc rien n'est
 * enfermé (seuls les fichiers d'Eclipse restent intouchables). Sinon : le réglage /sandbox de l'utilisateur.
 */
export function sandboxFor(mode: string, pref: boolean): boolean {
  if (mode === "bypass") return available().ok
  if (mode === "bypass-total") return false
  return pref && available().ok
}

/** Un agent reçoit tous les droits en bypass total, ou en bypass s'il peut être enfermé dans le projet. */
export function agentBypass(mode: string): boolean {
  return mode === "bypass-total" || (mode === "bypass" && available().ok)
}

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
  const args = [b, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--tmpfs", "/tmp", "--die-with-parent"]
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
 * C'est un garde-fou contre les erreurs (un agent qui se trompe de dossier), pas une prison : un processus garde
 * l'accès au réseau et aux services de la session (D-Bus, systemd --user) ; la sandbox reste la protection forte.
 */
export function guard(cmd: string[], cwd: string): string[] {
  const b = process.platform === "linux" ? Bun.which("bwrap") : null
  if (!b) {
    // sans bubblewrap : au moins aucune élévation de droits (sudo, pkexec…) pour la commande et ses descendants
    const sp = process.platform === "linux" ? Bun.which("setpriv") : null
    return sp ? [sp, "--no-new-privs", "--", ...cmd] : cmd
  }
  // espace de PID privé : /proc ne montre que les processus de la commande (pas de passage par /proc/PID/root d'un
  // processus hors garde), et tout l'arbre meurt avec elle, même un descendant qui a créé sa propre session
  const args = [b, "--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc"]
  for (const p of guardPaths()) args.push("--ro-bind", p, p)
  args.push("--die-with-parent", "--chdir", cwd, "--", ...cmd)
  return args
}

/** Dossiers de réglages qu'un agent doit pouvoir écrire (sessions, connexion). */
export function agentStateDirs(agent: string): string[] {
  const h = home()
  return ({
    claude: [join(h, ".claude"), join(h, ".claude.json"), join(h, ".claude.json.backup"), join(h, ".local/share/claude"), join(h, ".local/state/claude")],
    codex: [join(h, ".codex")],
    gemini: [join(h, ".gemini")],
    opencode: [join(h, ".local/share/opencode"), join(h, ".config/opencode"), join(h, ".opencode")],
  } as Record<string, string[]>)[agent] ?? []
}
