/**
 * Serveurs MCP : configurés dans `<données>/mcp.json` (format habituel {"mcpServers": {nom: {command, args, env} | {url}}})
 * et `<projet>/.eclipse/mcp.json`. Leurs outils sont ajoutés à ceux des modèles d'API, sous le nom `mcp__serveur__outil`.
 * Chaque appel passe par les permissions (lecture libre seulement si le serveur annonce l'outil « readOnlyHint »).
 * Un serveur qui ne démarre pas n'empêche pas les autres ; son erreur est montrée par /mcp.
 * Un serveur déclaré par un PROJET (.eclipse/mcp.json, contenu de dépôt non fiable) n'est jamais lancé sans
 * « /mcp approuver NOM » ; l'approbation porte sur l'empreinte de sa configuration et du dossier : si elle change,
 * il faut la redonner.
 */
import { VERSION } from "./version"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { dataDir } from "./paths"

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  disabled?: boolean
}

export interface McpTool {
  server: string
  name: string
  fullName: string
  description: string
  schema: unknown
  readOnly: boolean
}

export interface McpStatus {
  name: string
  source: string
  state: "connecté" | "erreur" | "désactivé" | "connexion…" | "à approuver"
  tools: number
  error?: string
  launch?: string // ce qui serait lancé (montré avant l'approbation)
  fingerprint?: string // empreinte de la configuration montrée (c'est elle qui est approuvée)
}

const approvalsFile = () => join(dataDir(), "mcp-approuves.json")
const readApprovals = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(approvalsFile(), "utf8"))
  } catch {
    return {}
  }
}
/**
 * Empreinte d'un serveur de projet : dossier, nom, configuration complète (commande, arguments, variables, adresse)
 * et contenu des fichiers du projet que la commande désigne directement (ex. « node ./serveur.js ») : si l'un d'eux
 * change, l'approbation tombe. Les fichiers chargés ensuite par ce script ne sont pas suivis.
 */
export function fingerprint(cwd: string, name: string, cfg: McpServerConfig): string {
  const h = createHash("sha256").update(JSON.stringify([cwd, name, cfg.command ?? null, cfg.args ?? [], cfg.env ?? {}, cfg.url ?? null]))
  const root = (() => { try { return realpathSync.native(cwd) } catch { return cwd } })()
  for (const rel of trackedFiles(cwd, cfg)) h.update(`\0${rel}\0`).update(readFileSync(join(root, rel)))
  return h.digest("hex")
}

/** Fichiers du projet désignés directement par la commande ou ses arguments (y compris « --option=chemin »). */
export function trackedFiles(cwd: string, cfg: McpServerConfig): string[] {
  const out = new Set<string>()
  let root: string
  try {
    root = realpathSync.native(cwd)
  } catch {
    return []
  }
  const parts = [cfg.command, ...(cfg.args ?? [])].flatMap((x) => (x ? [x, ...(x.includes("=") ? [x.slice(x.indexOf("=") + 1)] : [])] : []))
  for (const part of parts) {
    // résolution physique, comme le fera le processus lancé (un « .. » après un lien suit la cible du lien) :
    // pas de normalisation lexicale avant realpath
    let real: string
    try {
      real = realpathSync.native(isAbsolute(part) ? part : `${cwd}${sep}${part}`)
    } catch {
      continue
    }
    const rel = relative(root, real)
    if (!rel || isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") continue // hors du projet
    try {
      if (statSync(real).isFile()) out.add(rel)
    } catch {}
  }
  return [...out].sort()
}

const akey = (cwd: string, name: string) => JSON.stringify([cwd, name])
export function isApproved(cwd: string, name: string, cfg: McpServerConfig): boolean {
  return readApprovals()[akey(cwd, name)] === fingerprint(cwd, name, cfg)
}
/** Approuve exactement l'empreinte montrée à l'utilisateur (pas une relecture du fichier). */
export function approveFingerprint(cwd: string, name: string, fp: string): void {
  const a = readApprovals()
  a[akey(cwd, name)] = fp
  writeFileSync(approvalsFile(), JSON.stringify(a, null, 2), { mode: 0o600 })
}
export function approve(cwd: string, name: string, cfg: McpServerConfig): void {
  approveFingerprint(cwd, name, fingerprint(cwd, name, cfg))
}
/** Retire l'approbation (même si le serveur n'est plus dans le fichier) ; `all` : tous les serveurs du projet. */
export function revoke(cwd: string, name: string, all = false): string[] {
  const a = readApprovals()
  const gone: string[] = []
  for (const k of Object.keys(a)) {
    let dir = "", n = ""
    try { [dir, n] = JSON.parse(k) } catch { continue }
    if (dir === cwd && (all || n === name)) {
      delete a[k]
      gone.push(n)
    }
  }
  writeFileSync(approvalsFile(), JSON.stringify(a, null, 2), { mode: 0o600 })
  return gone
}

/** Serveurs du projet en attente, lus UNE fois : c'est cette configuration-là qui est montrée puis approuvée. */
export function pendingProject(cwd: string): { name: string; cfg: McpServerConfig; fp: string; files: string[] }[] {
  const cfgs = loadConfigs(cwd)
  const globals = new Set(cfgs.filter((c) => c.source === "global").map((c) => c.name))
  return cfgs
    .filter((c) => c.source === "projet" && !c.invalid && !c.cfg.disabled && !globals.has(c.name) && !isApproved(cwd, c.name, c.cfg))
    .map((c) => ({ name: c.name, cfg: c.cfg, fp: fingerprint(cwd, c.name, c.cfg), files: trackedFiles(cwd, c.cfg) }))
}

/** Ce qui serait lancé, en entier (commande, arguments, variables d'environnement), pour décider en connaissance de cause. */
export const describeLaunch = (cfg: McpServerConfig) =>
  JSON.stringify(cfg.url ? { url: cfg.url } : { command: cfg.command, args: cfg.args ?? [], ...(cfg.env && Object.keys(cfg.env).length ? { env: cfg.env } : {}) })

/** Configuration valide ? (types attendus ; sinon le serveur est montré en erreur, jamais lancé) */
function checkCfg(c: any): string | null {
  if (!c || typeof c !== "object") return "configuration illisible"
  if (c.url !== undefined && typeof c.url !== "string") return "url doit être un texte"
  if (c.command !== undefined && typeof c.command !== "string") return "command doit être un texte"
  if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a: unknown) => typeof a === "string"))) return "args doit être une liste de textes"
  if (c.env !== undefined && !(c.env && typeof c.env === "object" && !Array.isArray(c.env) && Object.values(c.env).every((v) => typeof v === "string"))) return "env doit associer des noms à des textes"
  if (c.disabled !== undefined && typeof c.disabled !== "boolean") return "disabled doit valoir true ou false"
  if (!c.url && !c.command) return "ni command ni url"
  return null
}

export function loadConfigs(cwd: string): { name: string; cfg: McpServerConfig; source: string; invalid?: string }[] {
  const out: { name: string; cfg: McpServerConfig; source: string; invalid?: string }[] = []
  for (const [file, source] of [[join(dataDir(), "mcp.json"), "global"], [join(cwd, ".eclipse", "mcp.json"), "projet"]] as const) {
    if (!existsSync(file)) continue
    try {
      const j = JSON.parse(readFileSync(file, "utf8"))
      for (const [name, cfg] of Object.entries(j.mcpServers ?? j.servers ?? {})) {
        // nom d'un serveur de projet : identifiant simple (rien qui puisse tromper l'affichage : retours à la ligne…)
        const badName = source === "projet" && !/^[A-Za-z0-9_.@-]{1,64}$/.test(name) ? "nom de serveur invalide (lettres, chiffres, . _ - @ ; 64 caractères au plus)" : null
        const bad = badName ?? checkCfg(cfg)
        out.push(bad ? { name: badName ? JSON.stringify(name).slice(0, 66) : name, cfg: { disabled: true }, source, invalid: bad } : { name, cfg: cfg as McpServerConfig, source })
      }
    } catch (e) {
      out.push({ name: file, cfg: { disabled: true }, source, invalid: `fichier illisible : ${(e as Error).message}` })
    }
  }
  return out
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)

export class McpManager {
  clients = new Map<string, Client>()
  status: McpStatus[] = []
  tools: McpTool[] = []
  private gen = 0
  private connecting = new Set<Client>()

  /** (Re)lance les serveurs. Le statut est disponible dès le retour synchrone de l'appel (avant les connexions). */
  start(cwd: string, onChange?: () => void): Promise<void> {
    const gen = ++this.gen
    const cfgs = loadConfigs(cwd)
    const globals = new Set(cfgs.filter((c) => c.source === "global").map((c) => c.name))
    const reason = (c: (typeof cfgs)[number]): McpStatus["state"] | "doublon" | "invalide" | null =>
      c.invalid ? "invalide" : c.cfg.disabled ? "désactivé" : c.source === "projet" && globals.has(c.name) ? "doublon" : c.source === "projet" && !isApproved(cwd, c.name, c.cfg) ? "à approuver" : null
    const reasons = cfgs.map(reason)
    this.status = cfgs.map((c, i) => {
      const r = reasons[i]
      return {
        name: c.name, source: c.source, tools: 0,
        state: r === "invalide" || r === "doublon" ? "erreur" : r ?? "connexion…",
        error: r === "invalide" ? c.invalid : r === "doublon" ? "même nom qu'un serveur global : renommez-le dans .eclipse/mcp.json" : undefined,
        launch: r === "à approuver" ? describeLaunch(c.cfg) : undefined,
        fingerprint: r === "à approuver" ? fingerprint(cwd, c.name, c.cfg) : undefined,
      }
    })
    onChange?.()
    return (async () => {
      await this.close()
      if (gen !== this.gen) return
      await Promise.all(cfgs.map(async (c, i) => {
        if (reasons[i]) return
        // serveur de projet : l'empreinte est recalculée juste avant le lancement (un script modifié pendant la
        // fermeture des anciens serveurs n'est pas lancé sous l'ancienne approbation)
        if (c.source === "projet" && !isApproved(cwd, c.name, c.cfg)) {
          this.status[i] = { ...this.status[i], state: "à approuver", launch: describeLaunch(c.cfg), fingerprint: fingerprint(cwd, c.name, c.cfg) }
          return void onChange?.()
        }
        const client = new Client({ name: "eclipse", version: VERSION })
        this.connecting.add(client) // fermé aussi par close() pendant la connexion
        try {
          const transport = c.cfg.url ? new StreamableHTTPClientTransport(new URL(c.cfg.url))
            : new StdioClientTransport({ command: c.cfg.command!, args: c.cfg.args ?? [], env: { ...(process.env as Record<string, string>), ...(c.cfg.env ?? {}) }, cwd, stderr: "ignore" })
          await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error("pas de réponse en 20 s")), 20_000))])
          const res = await client.listTools()
          if (gen !== this.gen) return void client.close().catch(() => {}) // relancé ou retiré entre-temps : rien n'est publié
          this.clients.set(c.name, client)
          for (const t of res.tools) this.tools.push({ server: c.name, name: t.name, fullName: `mcp__${safe(c.name)}__${safe(t.name)}`, description: (t.description ?? "").slice(0, 500),
                                                       schema: t.inputSchema ?? { type: "object", properties: {} }, readOnly: !!(t as any).annotations?.readOnlyHint })
          this.status[i] = { ...this.status[i], state: "connecté", tools: res.tools.length }
        } catch (e) {
          client.close().catch(() => {})
          if (gen === this.gen) this.status[i] = { ...this.status[i], state: "erreur", error: (e as Error).message.slice(0, 200) }
        } finally {
          this.connecting.delete(client)
        }
        if (gen === this.gen) onChange?.()
      }))
    })()
  }

  openAiTools() {
    return this.tools.map((t) => ({ type: "function", function: { name: t.fullName, description: `[MCP ${t.server}] ${t.description}`, parameters: t.schema } }))
  }

  find(fullName: string): McpTool | undefined {
    return this.tools.find((t) => t.fullName === fullName)
  }

  async call(t: McpTool, args: unknown): Promise<{ ok: boolean; output: string }> {
    const c = this.clients.get(t.server)
    if (!c) return { ok: false, output: `serveur MCP ${t.server} non connecté` }
    try {
      const r: any = await c.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> })
      const text = (r.content ?? []).map((x: any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n")
      return { ok: !r.isError, output: text.slice(0, 30_000) || "(réponse vide)" }
    } catch (e) {
      return { ok: false, output: `erreur MCP : ${(e as Error).message}` }
    }
  }

  private closing: Promise<unknown> = Promise.resolve()
  async close(): Promise<void> {
    const all = [...this.clients.values(), ...this.connecting]
    this.clients.clear()
    this.connecting.clear()
    this.tools = []
    // une fermeture déjà lancée est attendue aussi : stopAll() ne rend la main qu'une fois tout fermé
    this.closing = Promise.all([this.closing, ...all.map((c) => c.close().catch(() => {}))])
    await this.closing
  }

  /** Arrête tout et invalide les connexions en cours (retrait d'une approbation, fermeture d'Eclipse). */
  async stopAll(): Promise<void> {
    this.gen++
    await this.close()
  }
}
