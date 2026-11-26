/** Version détaillée : commit Git du dépôt d'Eclipse si disponible. */
import { join } from "node:path"

export function VERSION_INFO(): string {
  try {
    const r = Bun.spawnSync(["git", "-C", join(import.meta.dir, "..", ".."), "log", "-1", "--format=%h %cd", "--date=short"], { stdout: "pipe", stderr: "ignore" })
    const s = r.stdout.toString().trim()
    return s ? `commit ${s}` : "hors dépôt Git"
  } catch {
    return "hors dépôt Git"
  }
}
