/** Emplacements des données. Même dossier que la version Python : l'historique reste partagé. */
import { homedir } from "node:os"
import { join } from "node:path"

export function home(): string {
  return process.env.HOME || homedir()
}

/** ~/.local/share/poe-neural-code (ou $PNC_HOME, utilisé par les tests). */
export function dataDir(): string {
  if (process.env.PNC_HOME) return process.env.PNC_HOME
  if (process.platform === "win32") return join(process.env.APPDATA || join(home(), "AppData", "Roaming"), "poe-neural-code")
  return join(process.env.XDG_DATA_HOME || join(home(), ".local", "share"), "poe-neural-code")
}

export function short(p: string): string {
  const h = home()
  return p.startsWith(h) ? "~" + p.slice(h.length) : p
}
