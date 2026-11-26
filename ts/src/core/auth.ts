/**
 * Vérification du mot de passe de l'ordinateur avant le bypass. C'est le système qui le vérifie (polkit : la fenêtre
 * d'authentification de KDE, GNOME…, ou une invite texte sans session graphique) : Eclipse ne voit jamais le mot de passe.
 * La commande lancée en cas de succès est `true`, qui ne fait rien.
 * `sudo` ne sert pas de vérification : configuré sans mot de passe, il accepterait n'importe quoi.
 */
export type AuthResult = { ok: true } | { ok: false; reason: string }

type Spawner = (cmd: string[]) => Promise<number>

const defaultSpawn: Spawner = async (cmd) => {
  const p = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] })
  return p.exited
}

export async function verifyPassword(spawn: Spawner = defaultSpawn): Promise<AuthResult> {
  if (process.platform === "win32") return { ok: false, reason: "vérification Windows pas encore disponible dans cette version" }
  const pkexec = Bun.which("pkexec")
  const yes = Bun.which("true") ?? "/usr/bin/true"
  if (!pkexec) return { ok: false, reason: "polkit (pkexec) est absent : impossible de vérifier le mot de passe, bypass refusé" }
  const code = await spawn([pkexec, yes])
  if (code === 0) return { ok: true }
  // pkexec : 126 = authentification refusée ou annulée, 127 = pas d'agent d'authentification ni de terminal
  return { ok: false, reason: code === 126 ? "authentification refusée ou annulée" : code === 127 ? "aucune fenêtre d'authentification disponible" : `échec de la vérification (code ${code})` }
}
