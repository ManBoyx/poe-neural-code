/**
 * Skills et plugins.
 *
 * Skills : dossiers contenant un SKILL.md (en-tête name/description), aux mêmes emplacements que la version Python :
 * projet (.eclipse/skills, .claude/skills, .opencode/skills, .agents/skills) et global (~/.config/eclipse/skills,
 * ~/.claude/skills, ~/.config/opencode/skills). Le modèle reçoit le catalogue (nom + description) et charge le contenu
 * avec l'outil `skill` ; un skill du PROJET est du contenu de dépôt non fiable : son chargement est confirmé.
 *
 * Plugins : fichiers .ts ou .js dans .eclipse/plugins (projet) ou ~/.config/eclipse/plugins (global), qui exportent
 * par défaut une fonction `(api) => void` ; `api.command(nom, description, (arg) => texte)` ajoute une commande « / ».
 * Un plugin n'est JAMAIS exécuté sans « /plugins trust NOM » ; la confiance porte sur l'empreinte du fichier : s'il
 * change, il faut la redonner. (Les plugins Python de l'ancienne version ne sont pas exécutés par celle-ci.)
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { dataDir, home } from "./paths"

export interface Skill {
  name: string
  description: string
  path: string
  scope: "projet" | "global"
}

const PROJECT_SKILLS = [".eclipse/skills", ".claude/skills", ".opencode/skills", ".agents/skills"]
const GLOBAL_SKILLS = [".config/eclipse/skills", ".claude/skills", ".config/opencode/skills"]

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  const out: Record<string, string> = {}
  const lines = (m?.[1] ?? "").split("\n")
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const i = line.indexOf(":")
    if (i <= 0 || /^\s/.test(line)) continue
    let v = line.slice(i + 1).trim()
    if (/^[>|][-+]?$/.test(v)) {
      // valeur YAML sur plusieurs lignes (« >- » ou « | ») : lignes indentées qui suivent
      const parts: string[] = []
      while (n + 1 < lines.length && /^\s+\S/.test(lines[n + 1])) parts.push(lines[++n].trim())
      v = parts.join(" ")
    }
    out[line.slice(0, i).trim()] = v.replace(/^["']|["']$/g, "")
  }
  return out
}

function findSkillFiles(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === "SKILL.md") out.push(p)
    else if (e.isDirectory() && !e.name.startsWith(".")) out.push(...findSkillFiles(p, depth + 1))
  }
  return out
}

export function discoverSkills(cwd: string): Skill[] {
  const seen = new Map<string, Skill>()
  const add = (dir: string, scope: Skill["scope"]) => {
    for (const f of findSkillFiles(dir)) {
      const fm = frontmatter(readFileSync(f, "utf8").slice(0, 4000))
      const name = fm.name || basename(dirname(f))
      if (!seen.has(name)) seen.set(name, { name, description: (fm.description ?? "").slice(0, 300), path: f, scope })
    }
  }
  for (const d of PROJECT_SKILLS) add(join(cwd, d), "projet")
  for (const d of GLOBAL_SKILLS) add(join(home(), d), "global")
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function skillCatalog(skills: Skill[]): string {
  if (!skills.length) return ""
  return "Skills disponibles (charge le contenu avec l'outil skill quand l'un d'eux correspond à la demande) :\n" +
         skills.slice(0, 60).map((s) => `- ${s.name} : ${s.description.slice(0, 160)}`).join("\n")
}

// ------------------------------------------------------------------ plugins
export interface PluginInfo {
  name: string
  path: string
  scope: "projet" | "global"
  hash: string
  trusted: boolean
  loaded: boolean
  error?: string
}

export interface PluginCommand {
  plugin: string
  name: string
  description: string
  run: (arg: string) => unknown
}

const trustFile = () => join(dataDir(), "plugins-trust.json")
const readTrust = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(trustFile(), "utf8"))
  } catch {
    return {}
  }
}

export function discoverPlugins(cwd: string): PluginInfo[] {
  const trust = readTrust()
  const out: PluginInfo[] = []
  for (const [dir, scope] of [[join(cwd, ".eclipse", "plugins"), "projet"], [join(home(), ".config", "eclipse", "plugins"), "global"]] as const) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!/\.(ts|js|mjs)$/.test(f)) continue
      const p = join(dir, f)
      if (!statSync(p).isFile()) continue
      const hash = createHash("sha256").update(readFileSync(p)).digest("hex")
      const name = f.replace(/\.(ts|js|mjs)$/, "")
      out.push({ name, path: p, scope, hash, trusted: trust[p] === hash, loaded: false })
    }
  }
  return out
}

export function setTrust(p: PluginInfo, on: boolean): void {
  const t = readTrust()
  if (on) t[p.path] = p.hash
  else delete t[p.path]
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(trustFile(), JSON.stringify(t, null, 2), { mode: 0o600 })
}

/** Charge les plugins de confiance et renvoie leurs commandes. Un plugin qui plante est signalé, les autres continuent. */
export async function loadPlugins(list: PluginInfo[]): Promise<PluginCommand[]> {
  const cmds: PluginCommand[] = []
  for (const p of list) {
    if (!p.trusted) continue
    try {
      const mod = await import(p.path + `?h=${p.hash.slice(0, 8)}`)
      const fn = mod.default
      if (typeof fn !== "function") throw new Error("pas de fonction exportée par défaut")
      await fn({ command: (name: string, description: string, run: (arg: string) => unknown) => cmds.push({ plugin: p.name, name, description, run }) })
      p.loaded = true
    } catch (e) {
      p.error = (e as Error).message.slice(0, 200)
    }
  }
  return cmds
}
