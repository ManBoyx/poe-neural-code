/**
 * Outils donnés aux modèles d'API (appels d'outils au format OpenAI). Chemins confinés au dossier du projet et aux
 * dossiers ajoutés (/add-dir) ; hors de ces dossiers, une confirmation est toujours demandée (sauf bypass total).
 * Chaque écriture et chaque commande passe par les permissions ; la sortie d'une commande est bornée.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { isDestructive, type Permissions } from "./permissions"
import { runCmd } from "./proc"
import { guard, sandboxFor, wrap } from "./sandbox"
import { isProtected } from "./protect"
import type { Kind, Memory } from "./memory"
import type { McpManager } from "./mcp"
import type { Skill } from "./extensions"

/**
 * Élévation de droits (sudo, doas, pkexec, run0, su) lancée comme commande, où qu'elle soit dans la ligne : début,
 * après ; & | ( { ` $( ou !, derrière env/exec/nohup/time/xargs…, avec des variables (X=1) ou par son chemin
 * (/usr/bin/sudo). Un simple argument (« grep su ») n'est pas visé. Ce n'est qu'un premier filtre : la vraie barrière
 * est no_new_privs (bubblewrap ou setpriv), qui empêche tout programme setuid de devenir root.
 */
const ROOT_RE = /(?:^|[\n;&|(){}`!]|\$\()\s*(?:(?:env|exec|nohup|time|nice|ionice|command|builtin|xargs|stdbuf|setsid|chrt|then|else|elif|do|if|while|until|timeout\s+\S+)\s+|-\S+\s+|\w+=\S*\s+)*["']?(?:\S*\/)?(?:sudo|doas|pkexec|run0|su)["']?(?=$|[\s;&|()<>`])/

export interface ToolCall {
  id: string
  name: string
  args: string
}

export interface ToolResult {
  ok: boolean
  output: string
  diff?: string
}

export interface Todo {
  text: string
  status: "à faire" | "en cours" | "fait"
}

export interface ToolEnv {
  roots: string[] // [dossier du projet, …dossiers ajoutés]
  perms: Permissions
  memory: Memory
  districtId: number
  todos: Todo[]
  onTodos?: () => void
  signal?: AbortSignal
  sandbox?: boolean // true : commandes dans bubblewrap (écriture limitée au projet)
  skills?: Skill[]
  mcp?: McpManager
  helper?: (id: string, prompt: string) => Promise<{ ok: boolean; text: string }> // /fusion : consulter un autre modèle ou agent
  helpers?: { id: string; label: string }[]
}

const MAX_OUT = 20_000

export const TOOL_DEFS = [
  { name: "read_file", description: "Lire un fichier texte du projet (numéros de ligne inclus). offset/limit en lignes.",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "list_dir", description: "Lister un dossier du projet.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "search_files", description: "Chercher un motif (expression régulière) dans les fichiers du projet. glob optionnel (ex. *.ts).",
    parameters: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } },
  { name: "write_file", description: "Créer ou remplacer un fichier (contenu complet). Confirmation selon les permissions.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Remplacer un passage exact (old) par un autre (new) dans un fichier. old doit apparaître une seule fois.",
    parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
  { name: "run_command", description: "Lancer une commande shell dans le dossier du projet (tests, build…). Délai par défaut 120 s. Confirmation selon les permissions. Pas de sudo.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_s: { type: "integer" } }, required: ["command"] } },
  { name: "todo_write", description: "Remplacer la liste de tâches de la session (statut : à faire, en cours, fait).",
    parameters: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, status: { type: "string", enum: ["à faire", "en cours", "fait"] } }, required: ["text", "status"] } } }, required: ["items"] } },
  { name: "memory_note", description: "Enregistrer une information durable dans la mémoire du projet (fait, décision, contrainte, tâche…).",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["fact", "decision", "constraint", "task", "goal", "error", "question"] }, content: { type: "string" }, key: { type: "string" } }, required: ["kind", "content"] } },
  { name: "skill", description: "Charger le contenu d'un skill du catalogue (instructions spécialisées).",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "ask_helper", description: "Consulter un autre modèle ou agent configuré avec /fusion (avis, relecture, deuxième opinion). Il ne modifie rien.",
    parameters: { type: "object", properties: { helper: { type: "string" }, prompt: { type: "string" } }, required: ["helper", "prompt"] } },
  { name: "memory_search", description: "Chercher dans la mémoire du projet (éléments, résumés, discussions passées).",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
] as const

export const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "search_files", "memory_search", "todo_write", "skill", "ask_helper"])

/** Outils proposés au modèle : intégrés (skill et ask_helper seulement s'ils servent), puis ceux des serveurs MCP. */
export function openAiTools(env?: Pick<ToolEnv, "skills" | "mcp" | "helpers">) {
  return [
    ...TOOL_DEFS.filter((d) => (d.name !== "skill" || env?.skills?.length) && (d.name !== "ask_helper" || env?.helpers?.length))
      .map((d) => ({ type: "function", function: { name: d.name, description: d.name === "ask_helper" && env?.helpers ? `${d.description} Disponibles : ${env.helpers.map((h) => h.id).join(", ")}.` : d.description, parameters: d.parameters } })),
    ...(env?.mcp?.openAiTools() ?? []),
  ]
}

/** Résumé lisible d'un appel (pas de JSON brut à l'écran). */
export function summarize(name: string, a: any): string {
  if (name === "run_command") return String(a.command ?? "")
  if (name === "search_files") return `« ${a.pattern ?? ""} »${a.glob ? " dans " + a.glob : ""}`
  if (name === "todo_write") return `${(a.items ?? []).length} tâche(s)`
  if (name === "memory_note") return `${a.kind ?? ""} : ${String(a.content ?? "").slice(0, 60)}`
  if (name === "memory_search") return `« ${a.query ?? ""} »`
  if (name === "skill") return String(a.name ?? "")
  if (name === "ask_helper") return `${a.helper ?? ""} ← ${String(a.prompt ?? "").slice(0, 60)}`
  return String(a.path ?? "")
}

function realish(p: string): string {
  // chemin réel même si le fichier n'existe pas encore (on remonte jusqu'au premier parent existant)
  let cur = p
  const tail: string[] = []
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(cur.slice(dirname(cur).length + 1))
    cur = dirname(cur)
  }
  try {
    return join(realpathSync(cur), ...tail)
  } catch {
    return p
  }
}

export function locate(env: ToolEnv, p: string): { abs: string; outside: boolean; rel: string } {
  const abs = realish(isAbsolute(p) ? p : resolve(env.roots[0], p))
  const root = env.roots.find((r) => {
    const rr = realish(r)
    const rel = relative(rr, abs)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  })
  return { abs, outside: !root, rel: root ? relative(realish(root), abs) || "." : abs }
}

function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n")
  const b = after.split("\n")
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length - 1
  let eb = b.length - 1
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--
    eb--
  }
  const ctx = 2
  const from = Math.max(0, s - ctx)
  const lines = [`--- ${path}`, `+++ ${path}`, `@@ -${from + 1} +${from + 1} @@`]
  for (let i = from; i < s; i++) lines.push(" " + a[i])
  for (let i = s; i <= ea; i++) lines.push("-" + a[i])
  for (let i = s; i <= eb; i++) lines.push("+" + b[i])
  for (let i = ea + 1; i <= Math.min(a.length - 1, ea + ctx); i++) lines.push(" " + a[i])
  return lines.slice(0, 400).join("\n")
}

export async function runTool(env: ToolEnv, call: ToolCall): Promise<ToolResult> {
  let a: any
  try {
    a = JSON.parse(call.args || "{}")
  } catch {
    return { ok: false, output: "arguments illisibles (JSON invalide)" }
  }
  try {
    switch (call.name) {
      case "read_file": {
        const l = locate(env, a.path)
        if (!(await env.perms.authorize({ tool: "read_file", kind: "read", summary: l.rel, outside: l.outside, grantKey: "read-outside" }))) return { ok: false, output: "lecture refusée" }
        if (!existsSync(l.abs)) return { ok: false, output: `fichier introuvable : ${a.path}` }
        if (statSync(l.abs).size > 2_000_000) return { ok: false, output: "fichier trop gros (plus de 2 Mo)" }
        const lines = readFileSync(l.abs, "utf8").split("\n")
        const off = Math.max(0, (a.offset ?? 1) - 1)
        const lim = Math.min(a.limit ?? 2000, 2000)
        const out = lines.slice(off, off + lim).map((x, i) => `${String(off + i + 1).padStart(5)}  ${x}`).join("\n")
        return { ok: true, output: out + (off + lim < lines.length ? `\n… ${lines.length - off - lim} lignes de plus (offset ${off + lim + 1})` : "") }
      }
      case "list_dir": {
        const l = locate(env, a.path || ".")
        if (!(await env.perms.authorize({ tool: "list_dir", kind: "read", summary: l.rel, outside: l.outside, grantKey: "read-outside" }))) return { ok: false, output: "lecture refusée" }
        const es = readdirSync(l.abs, { withFileTypes: true }).filter((e) => e.name !== ".git").sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name))
        return { ok: true, output: es.slice(0, 500).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(vide)" }
      }
      case "search_files": {
        const args = Bun.which("rg") ? ["rg", "-n", "--no-heading", "--max-count", "20", "-S", ...(a.glob ? ["-g", a.glob] : []), "--", a.pattern, "."]
                                     : ["grep", "-rnI", ...(a.glob ? [`--include=${a.glob}`] : []), "-e", a.pattern, "."]
        const r = await runCmd(args, { cwd: env.roots[0], timeoutMs: 30_000, signal: env.signal })
        const out = r.out.split("\n").slice(0, 200).join("\n")
        return { ok: r.code === 0 || r.code === 1, output: out || "aucun résultat" }
      }
      case "write_file":
      case "edit_file": {
        const l = locate(env, a.path)
        if (isProtected(l.abs)) return { ok: false, output: "refusé : c'est un fichier d'Eclipse. Les modèles n'écrivent jamais dans Eclipse ; travaille dans le dossier du projet." }
        const before = existsSync(l.abs) ? readFileSync(l.abs, "utf8") : ""
        let after: string
        if (call.name === "write_file") after = String(a.content ?? "")
        else {
          if (!existsSync(l.abs)) return { ok: false, output: `fichier introuvable : ${a.path}` }
          const n = before.split(String(a.old)).length - 1
          if (n === 0) return { ok: false, output: "passage « old » introuvable dans le fichier (il doit être copié exactement)" }
          if (n > 1) return { ok: false, output: `passage « old » présent ${n} fois : ajoutez du contexte pour qu'il soit unique` }
          after = before.replace(String(a.old), () => String(a.new))
        }
        const diff = unifiedDiff(l.rel, before, after)
        const ok = await env.perms.authorize({ tool: call.name, kind: "write", summary: `${existsSync(l.abs) ? "modifier" : "créer"} ${l.rel}`, detail: diff, outside: l.outside, grantKey: `write:${l.rel}` })
        if (!ok) return { ok: false, output: "modification refusée par l'utilisateur", diff }
        mkdirSync(dirname(l.abs), { recursive: true })
        writeFileSync(l.abs, after)
        return { ok: true, output: `${l.rel} : ${before ? "modifié" : "créé"} (${after.split("\n").length} lignes)`, diff }
      }
      case "run_command": {
        const cmd = String(a.command ?? "").trim()
        if (!cmd) return { ok: false, output: "commande vide" }
        if (isProtected(env.roots[0])) return { ok: false, output: "refusé : le dossier de travail est un dossier d'Eclipse. Ouvrez un projet (/projet NOM)." }
        if (ROOT_RE.test(cmd)) return { ok: false, output: "sudo n'est pas permis aux modèles : lancez la commande vous-même si elle est nécessaire" }
        const confined = sandboxFor(env.perms.mode, !!env.sandbox)
        const ok = await env.perms.authorize({ tool: "run_command", kind: "exec", summary: cmd, detail: cmd, destructive: isDestructive(cmd), confined, grantKey: `exec:${confined ? "enfermée" : "libre"}:${cmd.split(/\s+/)[0]}` })
        if (!ok) return { ok: false, output: "commande refusée par l'utilisateur" }
        let sh = process.platform === "win32" ? ["cmd", "/c", cmd] : [process.env.SHELL?.endsWith("zsh") ? "zsh" : "bash", "-lc", cmd]
        sh = confined ? wrap(sh, env.roots, env.roots[0]) : guard(sh, env.roots[0])
        const r = await runCmd(sh, { cwd: env.roots[0], timeoutMs: Math.min(3600, a.timeout_s ?? 120) * 1000, signal: env.signal })
        let out = (r.out + (r.err ? (r.out ? "\n" : "") + r.err : "")).trim()
        if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT / 2) + `\n… ${out.length - MAX_OUT} caractères coupés …\n` + out.slice(-MAX_OUT / 2)
        if (r.timedOut) return { ok: false, output: out + `\n(délai de ${a.timeout_s ?? 120} s dépassé : commande arrêtée)` }
        return { ok: r.code === 0, output: (out || "(aucune sortie)") + (r.code ? `\n(code de sortie ${r.code})` : "") }
      }
      case "todo_write": {
        env.todos.splice(0, env.todos.length, ...((a.items ?? []) as Todo[]).map((x) => ({ text: String(x.text), status: (["à faire", "en cours", "fait"].includes(x.status) ? x.status : "à faire") as Todo["status"] })))
        env.onTodos?.()
        return { ok: true, output: env.todos.map((x, i) => `${i + 1}. [${x.status}] ${x.text}`).join("\n") || "(liste vide)" }
      }
      case "memory_note": {
        const r = env.memory.addItem(env.districtId, (a.kind ?? "fact") as Kind, String(a.content ?? ""), { key: a.key })
        return { ok: true, output: r.duplicate ? "déjà en mémoire" : `enregistré (n° ${r.id})${r.contradiction ? " — contradiction avec une note précédente signalée à l'utilisateur" : ""}` }
      }
      case "memory_search": {
        const hits = env.memory.search(String(a.query ?? ""), { districtId: env.districtId, limit: 8 })
        return { ok: true, output: hits.map((h) => `[${h.layer}] ${h.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "rien en mémoire" }
      }
      case "skill": {
        const s = env.skills?.find((x) => x.name === a.name)
        if (!s) return { ok: false, output: `skill inconnu : ${a.name}` }
        // skill du projet : contenu de dépôt non fiable, chargé après confirmation
        if (s.scope === "projet" && !(await env.perms.authorize({ tool: "skill", kind: "read", summary: `charger le skill du projet « ${s.name} »`, detail: readFileSync(s.path, "utf8").slice(0, 3000), outside: true, grantKey: `skill:${s.name}` })))
          return { ok: false, output: "chargement du skill refusé" }
        return { ok: true, output: readFileSync(s.path, "utf8").slice(0, 20_000) }
      }
      case "ask_helper": {
        if (!env.helper) return { ok: false, output: "aucun assistant configuré (/fusion add ID)" }
        const r = await env.helper(String(a.helper ?? ""), String(a.prompt ?? ""))
        return { ok: r.ok, output: r.text.slice(0, 20_000) }
      }
    }
    if (call.name.startsWith("mcp__") && env.mcp) {
      const tool = env.mcp.find(call.name)
      if (!tool) return { ok: false, output: `outil MCP inconnu : ${call.name}` }
      const ok = await env.perms.authorize({ tool: `MCP ${tool.server}`, kind: tool.readOnly ? "read" : "exec", summary: `${tool.name} ${JSON.stringify(a).slice(0, 120)}`,
                                             detail: JSON.stringify(a, null, 2).slice(0, 2000), grantKey: `mcp:${call.name}` })
      if (!ok) return { ok: false, output: "appel MCP refusé par l'utilisateur" }
      return env.mcp.call(tool, a)
    }
    return { ok: false, output: `outil inconnu : ${call.name}` }
  } catch (e) {
    return { ok: false, output: `erreur : ${(e as Error).message}` }
  }
}
