/** Version d'Eclipse et détail (commit Git du dépôt si disponible, sinon date de construction de l'exécutable). */
import { join } from "node:path"
import pkg from "../../package.json"

declare const ECLIPSE_BUILD: string | undefined // injecté par `bun build --define` (packaging/cli-ts/build.sh)

export const VERSION: string = pkg.version

export function VERSION_INFO(): string {
  if (typeof ECLIPSE_BUILD !== "undefined" && ECLIPSE_BUILD) return ECLIPSE_BUILD
  try {
    const r = Bun.spawnSync(["git", "-C", join(import.meta.dir, "..", ".."), "log", "-1", "--format=%h %cd", "--date=short"], { stdout: "pipe", stderr: "ignore" })
    const s = r.stdout.toString().trim()
    return s ? `commit ${s}` : "hors dépôt Git"
  } catch {
    return "hors dépôt Git"
  }
}
