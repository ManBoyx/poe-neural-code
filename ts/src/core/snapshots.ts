/**
 * Instantanés du dossier de travail pour /undo et /redo, dans un dépôt Git « fantôme » rangé dans les données
 * d'Eclipse : le dépôt Git du projet (s'il existe) n'est jamais touché. Les fichiers ignorés par .gitignore ne sont
 * pas suivis. Un dossier trop gros (ou le dossier personnel entier) n'est pas suivi : /undo le dit au lieu de geler.
 */
import { createHash } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { dataDir } from "./paths"
import { runCmd } from "./proc"

const MAX_FILES = 20_000

export class Snapshots {
  gitDir: string
  constructor(public root: string) {
    this.gitDir = join(dataDir(), "snapshots-ts", createHash("sha256").update(root).digest("hex").slice(0, 16))
  }

  private git(args: string[], timeoutMs = 60_000) {
    return runCmd(["git", `--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, "-c", "user.name=Eclipse", "-c", "user.email=eclipse@localhost",
                   "-c", "core.autocrlf=false", ...args], { timeoutMs, cwd: this.root })
  }

  /** Raison pour laquelle le dossier n'est pas suivi, ou null s'il l'est. */
  async unsupported(): Promise<string | null> {
    if (this.root === homedir() || this.root === "/") return "le dossier personnel entier n'est pas suivi (ouvrez un projet)"
    mkdirSync(this.gitDir, { recursive: true })
    const init = await this.git(["init", "-q"])
    if (init.code !== 0) return "git indisponible : " + init.err.trim().split("\n")[0]
    const r = await this.git(["ls-files", "--others", "--cached", "--exclude-standard"], 20_000)
    if (r.timedOut) return "dossier trop gros pour les instantanés"
    const n = r.out.split("\n").filter(Boolean).length
    return n > MAX_FILES ? `dossier trop gros pour les instantanés (${n} fichiers)` : null
  }

  /** Prend un instantané ; renvoie son identifiant (commit), ou null si impossible. */
  async snapshot(label: string): Promise<string | null> {
    if (await this.unsupported()) return null
    await this.git(["add", "-A"])
    await this.git(["commit", "-q", "--allow-empty", "--no-verify", "-m", label])
    const h = await this.git(["rev-parse", "HEAD"])
    return h.code === 0 ? h.out.trim() : null
  }

  /** Remet le dossier dans l'état de `target` : fichiers modifiés restaurés, fichiers ajoutés depuis supprimés. */
  async restore(target: string): Promise<{ ok: boolean; changed: string[]; error?: string }> {
    const cur = await this.snapshot("avant restauration")
    if (!cur) return { ok: false, changed: [], error: "instantané impossible" }
    const diff = await this.git(["diff", "--name-status", "--no-renames", target, cur])
    const changed = diff.out.split("\n").filter(Boolean)
    for (const line of changed) {
      const [st, ...f] = line.split("\t")
      const file = f.join("\t")
      if (st === "A") rmSync(join(this.root, file), { force: true }) // ajouté après la cible : retiré
    }
    const co = await this.git(["checkout", target, "--", "."])
    if (co.code !== 0 && changed.some((l) => !l.startsWith("A"))) return { ok: false, changed, error: co.err.trim().split("\n")[0] }
    await this.snapshot("après restauration")
    return { ok: true, changed: changed.map((l) => l.replace("\t", " ")) }
  }
}
