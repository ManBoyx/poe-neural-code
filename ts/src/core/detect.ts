/**
 * Détection des agents CLI installés (même logique que la version Python 4.0) :
 * PATH du processus, puis PATH du shell de connexion (les lanceurs du menu reçoivent un PATH réduit),
 * puis dossiers d'installation connus, puis chemin indiqué à la main. Chaque agent est cherché à part :
 * l'échec de l'un ne bloque jamais les autres. Les agents absents sont rendus (grisés), jamais cachés.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { home } from "./paths"
import { runCmd } from "./proc"

export interface AgentSpec {
  id: string
  label: string
  binaries: string[]
  install: string // commande d'installation conseillée
}

export const AGENTS: AgentSpec[] = [
  { id: "claude", label: "Claude Code", binaries: ["claude"], install: "curl -fsSL https://claude.ai/install.sh | bash" },
  { id: "codex", label: "Codex CLI", binaries: ["codex"], install: "npm install -g @openai/codex" },
  { id: "opencode", label: "OpenCode", binaries: ["opencode"], install: "curl -fsSL https://opencode.ai/install | bash" },
  { id: "gemini", label: "Gemini CLI", binaries: ["gemini"], install: "npm install -g @google/gemini-cli" },
  { id: "kiro", label: "Kiro CLI", binaries: ["kiro-cli"], install: "voir kiro.dev" },
  { id: "aider", label: "Aider", binaries: ["aider"], install: "python -m pip install aider-install && aider-install" },
  { id: "goose", label: "Goose", binaries: ["goose"], install: "voir block.github.io/goose" },
  { id: "qwen", label: "Qwen Code", binaries: ["qwen"], install: "npm install -g @qwen-code/qwen-code" },
  { id: "cursor", label: "Cursor CLI", binaries: ["cursor-agent"], install: "curl https://cursor.com/install -fsS | bash" },
  { id: "copilot", label: "GitHub Copilot CLI", binaries: ["copilot"], install: "npm install -g @github/copilot" },
  { id: "amp", label: "Amp", binaries: ["amp"], install: "npm install -g @sourcegraph/amp" },
  { id: "crush", label: "Crush", binaries: ["crush"], install: "voir github.com/charmbracelet/crush" },
  { id: "droid", label: "Droid (Factory)", binaries: ["droid"], install: "voir factory.ai" },
  { id: "cline", label: "Cline CLI", binaries: ["cline"], install: "npm install -g cline" },
]

export type Source = "PATH" | "PATH de votre shell" | "dossier d'installation courant" | "chemin indiqué à la main"

export interface Detected {
  id: string
  label: string
  installed: boolean
  path?: string
  source?: Source
  version?: string
  versionError?: string
  reason?: string
  install: string
}

function isExec(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    if (process.platform === "win32") return true
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function knownDirs(h = home()): string[] {
  const out = [
    ".local/bin", "bin", ".opencode/bin", ".claude/local", ".claude/bin", ".kiro/bin", ".local/share/kiro-cli/bin", ".cargo/bin", ".bun/bin",
    ".deno/bin", ".volta/bin", ".npm-global/bin", ".npm-packages/bin", ".local/share/pnpm", ".yarn/bin", ".config/yarn/global/node_modules/.bin",
    ".local/share/mise/shims", ".asdf/shims", ".amp/bin", ".factory/bin", "go/bin",
  ].map((r) => join(h, r))
  out.push("/usr/local/bin", "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin", "/var/lib/snapd/snap/bin", "/usr/bin", "/bin")
  for (const base of [join(h, ".nvm/versions/node"), join(h, ".local/share/fnm/node-versions"), join(h, ".fnm/node-versions")]) {
    try {
      const vs = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const v of vs) out.push(base.includes("nvm") ? join(base, v, "bin") : join(base, v, "installation", "bin"))
    } catch {}
  }
  try {
    for (const line of readFileSync(join(h, ".npmrc"), "utf8").split("\n")) {
      const m = line.match(/^\s*prefix\s*=\s*(.+)$/)
      if (m) out.push(join(m[1].trim().replace(/^~/, h), "bin"))
    }
  } catch {}
  return out
}

let shellCache: { at: number; dirs: string[] } | null = null

/** PATH du shell de connexion de l'utilisateur (4 s au plus, gardé 5 min). */
export async function shellPath(refresh = false): Promise<string[]> {
  if (process.env.ECLIPSE_AGENT_SCAN === "path" || process.platform === "win32") return []
  if (!refresh && shellCache && Date.now() - shellCache.at < 300_000) return shellCache.dirs
  const shell = process.env.SHELL || "/bin/sh"
  let dirs: string[] = []
  const r = await runCmd([shell, "-l", "-i", "-c", 'printf "__ECLIPSE_PATH__%s__ECLIPSE_PATH__" "$PATH"'], { timeoutMs: 4000 })
  const m = r.out.match(/__ECLIPSE_PATH__(.*?)__ECLIPSE_PATH__/s)
  if (m) dirs = m[1].split(delimiter).filter(Boolean)
  shellCache = { at: Date.now(), dirs }
  return dirs
}

export async function searchDirs(refresh = false): Promise<[string, Source][]> {
  const seen = new Set<string>()
  const out: [string, Source][] = []
  const add = (d: string, s: Source) => {
    if (d && !seen.has(d)) {
      seen.add(d)
      out.push([d, s])
    }
  }
  for (const d of (process.env.PATH || "").split(delimiter)) add(d, "PATH")
  if (process.env.ECLIPSE_AGENT_SCAN === "path") return out
  for (const d of await shellPath(refresh)) add(d, "PATH de votre shell")
  for (const d of knownDirs()) add(d, "dossier d'installation courant")
  return out
}

export function locate(a: AgentSpec, dirs: [string, Source][], manual?: string): { path: string; source: Source } | null {
  if (manual && isExec(manual)) return { path: manual, source: "chemin indiqué à la main" }
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const [d, s] of dirs) {
    for (const b of a.binaries) {
      for (const e of exts) {
        const p = join(d, b + e)
        if (existsSync(p) && isExec(p)) return { path: p, source: s }
      }
    }
  }
  return null
}

async function version(path: string, timeoutMs: number): Promise<{ version?: string; error?: string }> {
  const r = await runCmd([path, "--version"], { timeoutMs, env: { ...process.env, NO_COLOR: "1" } })
  if (r.timedOut) return { error: `« --version » sans réponse en ${timeoutMs / 1000} s` }
  if (r.code === null) return { error: r.err || "lancement impossible" }
  const line = (r.out.trim() || r.err.trim()).split("\n")[0]?.trim()
  return line ? { version: line.slice(0, 60) } : { error: `version illisible (code ${r.code})` }
}

/** Détecte tous les agents ; `withVersion` lit leur version en parallèle (délai généreux : certains démarrent lentement). */
export async function detect(opts: { withVersion?: boolean; refresh?: boolean; manual?: Record<string, string>; timeoutMs?: number } = {}): Promise<Detected[]> {
  const dirs = await searchDirs(opts.refresh)
  return Promise.all(
    AGENTS.map(async (a): Promise<Detected> => {
      try {
        const hit = locate(a, dirs, opts.manual?.[a.id])
        if (!hit) {
          return { id: a.id, label: a.label, installed: false, install: a.install,
                   reason: `« ${a.binaries.join(" » ou « ")} » introuvable dans ${dirs.length} dossiers` }
        }
        const d: Detected = { id: a.id, label: a.label, installed: true, path: hit.path, source: hit.source, install: a.install }
        if (opts.withVersion) {
          const v = await version(hit.path, opts.timeoutMs ?? 15_000)
          d.version = v.version
          d.versionError = v.error
        }
        return d
      } catch (e) {
        return { id: a.id, label: a.label, installed: false, install: a.install, reason: "erreur de détection : " + (e as Error).message }
      }
    }),
  )
}
