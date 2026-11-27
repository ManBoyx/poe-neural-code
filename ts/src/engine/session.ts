/**
 * Session sans écran, utilisée par le desktop (même moteur, mêmes données que le terminal : mémoire, sessions,
 * consommation, clés, serveurs MCP, projets, règle de protection d'Eclipse).
 *
 * Trois espaces, comme dans le desktop :
 *  - « conversation » : discussion avec un modèle d'API, sans outils de fichiers ; graphiques en ligne (blocs ```chart) ;
 *  - « work » : travail dans un projet (~/Projets/<nom>) avec les outils, un agent (Claude Code, Codex…) ou /cg ;
 *  - « medias » : génération d'images, de vidéos et de sons avec les modèles qui en produisent (catalogue Poe).
 * Les événements (texte, réflexion, outils, sous-agents, phases de /cg, autorisations, consommation) partent vers
 * l'écran par un rappel ; le serveur HTTP les relaie.
 */
import { closeSync, constants as FS, existsSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs"
import { join, sep } from "node:path"
import { Budget, estimateUsd } from "../core/budget"
import { cgTurn, CG_LABEL, type CgAgent, type CgMode } from "../core/cg"
import { streamChat, type Msg } from "../core/chat"
import { detect, type Detected } from "../core/detect"
import { levelValue } from "../core/effort"
import { discoverSkills, skillCatalog, type Skill } from "../core/extensions"
import { McpManager } from "../core/mcp"
import { estimateTokens, Memory, rememberRequest } from "../core/memory"
import { Permissions, type Decision, type PermMode, type Request } from "../core/permissions"
import { isProtected, listProjects, needsProject, openProject, PROTECT_RULE, projectsRoot, slug } from "../core/protect"
import { catalog, keyFor, provider, PROVIDERS, verifyKey, type ModelInfo, modelCategory, type ModelCategory } from "../core/providers"
import { agentModels, agentPowerFor, runAgent, type Power } from "../core/agents"
import { available as sandboxAvailable, sandboxFor } from "../core/sandbox"
import { Snapshots } from "../core/snapshots"
import { choose, load, save, type Choice, type State } from "../core/store"
import { openAiTools, READ_ONLY_TOOLS, runTool, summarize, type Todo, type ToolEnv } from "../core/tools"
import { short } from "../core/paths"

export type Space = "conversation" | "work" | "medias"

export type EngineEvent =
  | { type: "turn"; id: number; space: Space; text: string }
  | { type: "text"; text: string; who?: string; parent?: string }
  | { type: "thinking"; text: string; who?: string }
  | { type: "tool"; id: string; name: string; summary: string; done: boolean; ok?: boolean; output?: string; diff?: string; who?: string; parent?: string }
  | { type: "subagent"; agent: string; id: string; label: string; done: boolean; ok?: boolean; output?: string }
  | { type: "cg"; phase?: string; status?: { agent: CgAgent; status: string } }
  | { type: "perm"; id: number; req: Request }
  | { type: "notice"; text: string; level: "info" | "warn" | "error" }
  | { type: "usage"; input: number; output: number; measured: boolean; usd?: number | null }
  | { type: "done"; text: string; interrupted: boolean; seconds: number }
  | { type: "state" }

/** Image collée ou déposée dans la saisie du desktop (data URL). */
export interface PastedImage { name: string; dataUrl: string }
const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/
/** Signature des premiers octets de chaque format accepté. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  gif: (b) => /^GIF8[79]a$/.test(b.toString("latin1", 0, 6)),
}
/** Fin attendue de chaque format : une image tronquée (copie interrompue) est refusée. */
const COMPLETE: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])), // bloc IEND
  jpeg: (b) => b.subarray(-16).includes(Buffer.from([0xff, 0xd9])), // marqueur EOI (octets de remplissage tolérés)
  webp: (b) => b.readUInt32LE(4) + 8 <= b.length, // taille annoncée dans l'en-tête RIFF
  gif: (b) => b[b.length - 1] === 0x3b, // terminateur, dernier octet
}
/** Une image valide : data URL du bon format, base64 correct, octets qui sont bien une image de ce type, 12 Mo au plus. */
function validImage(x: any): boolean {
  if (!x || typeof x.dataUrl !== "string" || x.dataUrl.length > 12_000_000) return false
  const m = IMG_RE.exec(x.dataUrl)
  if (!m || m[2].length % 4 !== 0) return false
  const bytes = Buffer.from(m[2], "base64")
  return bytes.length > 12 && MAGIC[m[1]](bytes) && COMPLETE[m[1]](bytes)
}
/** Garde les images valides, 6 au plus. `rejected` : nombre d'images écartées (pour le signaler). */
export function cleanImages(list: unknown): { images: PastedImage[]; rejected: number } {
  if (!Array.isArray(list)) return { images: [], rejected: 0 }
  const ok = list.filter(validImage)
  const images = ok.slice(0, 6).map((x: any, i) => ({ name: String(x.name ?? `image-${i + 1}`).replace(/[^\w.-]/g, "_").slice(0, 60) || `image-${i + 1}`, dataUrl: x.dataUrl }))
  return { images, rejected: list.length - images.length }
}

/**
 * Dépose les images dans <projet>/.eclipse/images et renvoie leurs chemins relatifs. Aucun lien
 * symbolique n'est suivi (ni .eclipse, ni images, ni le fichier, créé exclusivement) : rien ne s'écrit hors du projet
 * ni dans les fichiers d'Eclipse.
 */
export function writeImages(cwd: string, images: PastedImage[]): string[] {
  const root = realpathSync.native(cwd)
  if (isProtected(root)) throw new Error("images : le dossier de travail est un dossier d'Eclipse")
  let dir = root
  for (const part of [".eclipse", "images"]) {
    dir = join(dir, part)
    try {
      if (!lstatSync(dir).isDirectory()) throw new Error(`images : ${part} n'est pas un vrai dossier (lien symbolique ou fichier)`)
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e
      mkdirSync(dir)
    }
  }
  if (!realpathSync.native(dir).startsWith(root + sep)) throw new Error("images : dossier hors du projet")
  const paths = images.map((im, i) => {
    const ext = im.dataUrl.slice(11, im.dataUrl.indexOf(";")).replace("jpeg", "jpg")
    const file = `${Date.now()}-${i + 1}-${im.name.replace(/\.[a-z0-9]+$/i, "")}.${ext}`
    const fd = openSync(join(dir, file), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
    try {
      // un dossier parent remplacé entre la vérification et l'ouverture : le fichier (encore vide) est retiré, rien n'est écrit
      if (process.platform === "linux") {
        const real = realpathSync.native(`/proc/self/fd/${fd}`)
        if (!real.startsWith(root + sep) || isProtected(real)) {
          try { unlinkSync(real) } catch { /* déjà parti */ }
          throw new Error("images : dossier déplacé pendant l'enregistrement, hors du projet — rien n'a été écrit")
        }
      }
      writeSync(fd, Buffer.from(im.dataUrl.slice(im.dataUrl.indexOf(",") + 1), "base64"))
    } finally { closeSync(fd) }
    return `.eclipse/images/${file}`
  })
  return paths
}

/** Canevas : un document que l'on voit à côté de la discussion et qui se met à jour en direct. */
export const CANVAS_RULE =
  "Mode canevas : quand on te demande une page, une interface, une affiche, un document ou tout design, réponds avec UN document HTML complet " +
  "dans un bloc ```html (CSS dans une balise <style>, sans JavaScript ni ressource externe sauf polices et images en https). " +
  "Il s'affiche en direct dans un panneau à côté de la discussion. Pour une modification, renvoie le document complet modifié. " +
  "Avant le bloc, une phrase courte sur ce que tu fais ; après, rien de plus."

export const CHART_RULE =
  "Pour illustrer des chiffres, tu peux insérer un graphique : un bloc ```chart contenant du JSON " +
  '{"type":"bar"|"line"|"pie","title":"…","labels":["…"],"series":[{"name":"…","data":[nombres]}]}. Il s\'affiche directement dans la discussion.'

export class EngineSession {
  st: State = load()
  mem = new Memory()
  budget = new Budget()
  mcp = new McpManager()
  perms: Permissions
  cwd: string
  district: number
  conv: number | null = null
  title = ""
  space: Space = "conversation"
  history: Msg[] = []
  todos: Todo[] = []
  detected: Detected[] = []
  skills: Skill[] = []
  models: Record<string, ModelInfo[]> = {}
  keyState: Record<string, string> = {}
  busy = false
  detecting = true // recherche des agents installés en cours (quelques secondes au démarrage)
  cgSessions: Partial<Record<CgAgent, string>> = {}
  agentSessions: Record<string, string> = {}
  private abort: AbortController | null = null
  private permWaiters = new Map<number, (d: Decision) => void>()
  private permSeq = 0
  private turnSeq = 0

  constructor(cwd: string, public emit: (e: EngineEvent) => void) {
    this.cwd = cwd
    this.district = this.mem.district(cwd)
    this.perms = new Permissions((req) => new Promise<Decision>((res) => {
      const id = ++this.permSeq
      this.permWaiters.set(id, res)
      this.emit({ type: "perm", id, req })
    }))
  }

  async init(): Promise<void> {
    try {
      this.detected = await detect({ withVersion: true, manual: this.st.agentPaths })
    } finally {
      this.detecting = false
      this.emit({ type: "state" })
    }
    this.skills = discoverSkills(this.cwd)
    this.mcp.start(this.cwd, () => this.emit({ type: "state" }))
    for (const p of PROVIDERS) this.loadProvider(p.id)
  }

  async loadProvider(id: string): Promise<void> {
    const p = provider(id)!
    const k = await keyFor(p)
    if (!k.ok) {
      this.keyState[id] = k.missing ? "clé à saisir" : k.reason
      return
    }
    if (!p.local) {
      const v = await verifyKey(p)
      this.keyState[id] = v.check === "refusée" ? "clé refusée" : "ok"
      if (v.check === "refusée") return
    }
    const r = await catalog(p)
    if (r.ok) {
      this.models[id] = r.models
      this.keyState[id] = "ok"
    } else this.keyState[id] = p.local ? "ne tourne pas" : r.reason
    this.emit({ type: "state" })
  }

  answerPerm(id: number, d: Decision): void {
    this.permWaiters.get(id)?.(d)
    this.permWaiters.delete(id)
  }

  interrupt(): void {
    this.abort?.abort()
    for (const [id, res] of this.permWaiters) {
      res("deny")
      this.permWaiters.delete(id)
    }
  }

  savePrefs(p: Partial<State["prefs"]>): void {
    this.st = { ...this.st, prefs: { ...this.st.prefs, ...p } }
    save(this.st)
    this.emit({ type: "state" })
  }

  choose(c: Choice): void {
    this.st = choose(this.st, c)
    save(this.st)
    this.emit({ type: "state" })
  }

  /** Réglages du modèle actif (recherche web, réflexion…), fusionnés avec ceux déjà choisis ; null efface un réglage. */
  setModelOptions(values: Record<string, unknown>): void {
    const c = this.st.current
    if (!c || c.kind !== "api") return
    const key = `${c.provider}/${c.model ?? ""}`
    const cur: Record<string, unknown> = { ...(this.st.prefs.options?.[key] ?? {}) }
    for (const [k, v] of Object.entries(values)) if (v === null || v === undefined) delete cur[k]
    else cur[k] = v
    this.savePrefs({ options: { ...(this.st.prefs.options ?? {}), [key]: cur } })
  }

  setPerm(m: PermMode): void {
    this.perms.setMode(m)
    this.emit({ type: "state" })
  }

  enterProject(name: string): string {
    const p = openProject(name)
    this.cwd = p
    this.district = this.mem.district(p)
    this.skills = discoverSkills(p)
    this.mcp.start(p, () => this.emit({ type: "state" }))
    this.newChat()
    return p
  }

  newChat(): void {
    if (this.busy) throw new Error("une réponse est en cours : attendez la fin ou arrêtez-la")
    this.conv = null
    this.title = ""
    this.history = []
    this.agentSessions = {}
    this.cgSessions = {}
    this.emit({ type: "state" })
  }

  openConversation(id: number) {
    const row = this.mem.db.query("SELECT title, district_id FROM conversations WHERE id=?").get(id) as { title: string; district_id: number } | null
    const msgs = this.mem.messages(id).filter((m) => m.role === "user" || m.role === "assistant")
    if (this.busy) throw new Error("une réponse est en cours : attendez la fin ou arrêtez-la avant d'ouvrir une autre discussion")
    this.conv = id
    this.title = (row?.title ?? "").replace(/^\[(cg|work|media)\]\s*/, "") // étiquette interne d'espace : jamais affichée
    if (row) this.district = row.district_id
    // une discussion de travail se reprend dans SON projet (fichiers, skills, serveurs MCP), jamais dans le projet actif
    const dpath = row ? (this.mem.db.query("SELECT path FROM districts WHERE id=?").get(row.district_id) as { path: string | null } | null)?.path : null
    if (dpath && dpath !== this.cwd && existsSync(dpath) && !isProtected(dpath)) {
      this.cwd = dpath
      this.skills = discoverSkills(dpath)
      this.mcp.start(dpath, () => this.emit({ type: "state" }))
    }
    this.space = (row?.title ?? "").startsWith("[cg]") || (row?.title ?? "").startsWith("[work]") ? "work" : (row?.title ?? "").startsWith("[media]") ? "medias" : "conversation"
    this.history = msgs.slice(-40).map((m) => ({ role: m.role as Msg["role"], content: m.content }))
    this.agentSessions = {}
    for (const m of this.mem.messages(id)) {
      try {
        const meta = JSON.parse(m.meta || "{}")
        if (meta.agent && meta.agentSession) this.agentSessions[meta.agent] = meta.agentSession
      } catch {}
    }
    return msgs.map((m) => ({ role: m.role, text: m.content }))
  }

  sessions() {
    return this.mem.conversations(undefined, 300).map((c) => ({
      id: c.id, title: (c.title ?? "").replace(/^\[(cg|work|media)\]\s*/, "") || `Session ${c.id}`, project: c.district, last: c.last, count: c.count,
      space: (c.title ?? "").startsWith("[media]") ? "medias" : (c.title ?? "").startsWith("[cg]") || (c.title ?? "").startsWith("[work]") ? "work" : "conversation",
      cg: (c.title ?? "").startsWith("[cg]"),
    }))
  }

  state() {
    const c = this.st.current
    const mi = this.modelInfo(c)
    return {
      cwd: this.cwd, cwdShort: short(this.cwd), protectedCwd: isProtected(this.cwd), needsProject: needsProject(this.cwd), projectsRoot: short(projectsRoot()),
      projects: listProjects().slice(0, 60).map((p) => ({ name: p.name, path: short(p.path), mtime: p.mtime })),
      current: c ?? null, label: this.label(), effort: c ? this.st.prefs.effort?.[`${c.provider}/${c.model ?? ""}`] ?? null : null, efforts: mi?.effort ?? [],
      modelParams: (mi?.params ?? []).map((p) => ({ name: p.name, kind: p.kind, choices: p.choices, description: p.description })),
      modelOptions: c ? this.st.prefs.options?.[`${c.provider}/${c.model ?? ""}`] ?? {} : {},
      modelOutput: mi?.output ?? null,
      deepResearch: Object.values(this.models).flat().filter((m) => /deep-research|researcher/i.test(m.id)).map((m) => ({ provider: m.provider, id: m.id })),
      recents: this.st.recents.slice(0, 8), busy: this.busy, title: this.title, conv: this.conv, space: this.space,
      perm: this.perms.mode, bypassVerified: this.perms.bypassVerified, sandbox: sandboxFor(this.perms.mode, this.st.prefs.sandbox !== false), sandboxPref: this.st.prefs.sandbox !== false,
      agents: this.detected.map((d) => ({ id: d.id, label: d.label, installed: d.installed, version: d.version, install: d.install })), detecting: this.detecting,
      providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, recommended: !!p.recommended, local: !!p.local, key: this.keyState[p.id] ?? "…", models: this.models[p.id]?.length ?? 0 })),
      mcp: this.mcp.status, skills: this.skills.length, todos: this.todos,
      cg: { lead: this.st.prefs.cgLead ?? "codex", mode: this.st.prefs.cgMode ?? "auto", review: this.st.prefs.cgReview !== false, subagents: this.st.prefs.cgSubagents !== false, agents: this.st.prefs.agents ?? {} },
      memory: this.mem.items(this.district).length,
    }
  }

  label(): string {
    const c = this.st.current
    if (!c) return "aucun modèle"
    if (c.kind === "agent") return this.detected.find((d) => d.id === c.provider)?.label ?? c.provider
    return `${c.model} · ${provider(c.provider)?.label ?? c.provider}`
  }

  modelInfo(c?: Choice): ModelInfo | undefined {
    return c?.kind === "api" ? this.models[c.provider]?.find((m) => m.id === c.model) : undefined
  }

  /** Modèles qui produisent des images, des vidéos ou des sons (espace Médias), d'après le catalogue du fournisseur. */
  mediaModels() {
    const out: { provider: string; id: string; output: string[]; price?: number; category: ModelCategory }[] = []
    for (const [pid, ms] of Object.entries(this.models))
      for (const m of ms) {
        const o = (m.output ?? []).filter((x) => x === "image" || x === "video" || x === "audio")
        if (o.length) out.push({ provider: pid, id: m.id, output: (m.output ?? []).includes("text") ? [...o, "text"] : o, price: m.priceOut, category: modelCategory(m) })
      }
    return out
  }

  private ensureConv(text: string, space: Space, cg = false): number {
    if (this.conv) return this.conv
    const tag = cg ? "[cg] " : space === "work" ? "[work] " : space === "medias" ? "[media] " : ""
    this.title = text.replace(/\s+/g, " ").slice(0, 60)
    this.conv = this.mem.newConversation(this.district, tag + this.title)
    return this.conv
  }

  /** Un message de l'utilisateur dans un espace. `cg` : Claude Code et Codex ensemble (espace work). */
  async send(text: string, space: Space, opts: { cg?: boolean; mediaModel?: { provider: string; id: string }; canvas?: string | null; images?: PastedImage[] } = {}): Promise<void> {
    const images = opts.images ?? []
    const marker = images.length ? `\n\n[${images.length} image${images.length > 1 ? "s" : ""} jointe${images.length > 1 ? "s" : ""}]` : ""
    if (this.busy) throw new Error("une réponse est déjà en cours")
    if (space === "work" && needsProject(this.cwd)) throw new Error("projet requis")
    this.space = space
    this.busy = true
    const turn = ++this.turnSeq
    this.emit({ type: "turn", id: turn, space, text })
    this.emit({ type: "state" })
    const t0 = Date.now()
    this.abort = new AbortController()
    let final = ""
    // modèle utilisé pour ce tour, figé au départ (un changement de modèle pendant la réponse ne le modifie pas)
    const used = space === "medias" ? opts.mediaModel?.id : opts.cg ? "claude+codex" : this.st.current?.model ?? this.st.current?.provider
    try {
      const id = this.mem.append(this.ensureConv(text, space, opts.cg), "user", text + marker) // les images ne vont pas dans la mémoire
      const fact = rememberRequest(text)
      if (fact) {
        this.mem.addItem(this.district, "fact", fact, { sourceArchiveId: id })
        this.emit({ type: "notice", text: `Mémorisé : « ${fact} »`, level: "info" })
      }
      // agents : les images sont déposées dans le projet, l'agent les lit par leur chemin
      const forAgent = images.length && space === "work" && (opts.cg || this.st.current?.kind === "agent") ? this.saveImages(images) : ""
      if (space === "medias") final = await this.media(text, opts.mediaModel, images)
      else if (space === "work" && opts.cg) final = await this.cg(text + forAgent)
      else if (this.st.current?.kind === "agent" && space === "work") final = await this.agent(this.st.current.provider, text + forAgent)
      else final = await this.api(text, space, opts.canvas, images)
      if (final && !this.abort.signal.aborted) {
        this.history.push({ role: "user", content: text + marker }, { role: "assistant", content: final })
        this.mem.append(this.conv!, "assistant", final, { space, model: used })
      }
    } catch (e) {
      this.emit({ type: "notice", text: (e as Error).message, level: "error" })
    } finally {
      const interrupted = !!this.abort?.signal.aborted
      this.abort = null
      this.busy = false
      this.emit({ type: "done", text: final, interrupted, seconds: (Date.now() - t0) / 1000 })
      this.emit({ type: "state" })
    }
  }

  private system(space: Space, tools: boolean, memText: string): string {
    const parts = [
      "Tu es Eclipse, un assistant. Réponds en français, clairement, en Markdown, sans aucune emoji.",
      space === "conversation" ? "Espace Conversation : discussion libre, sans accès aux fichiers. " + CHART_RULE
        : tools ? `Espace Work : tu travailles dans le projet ${this.cwd} avec tes outils. Lis avant de modifier. Permissions : ${this.perms.mode}.` : "",
      PROTECT_RULE,
      skillCatalog(this.skills),
      memText,
    ]
    return parts.filter(Boolean).join("\n\n")
  }

  private record(model: string, tin: number, tout: number, measured: boolean, mi?: ModelInfo, note = "desktop") {
    const usd = estimateUsd(mi?.priceIn, mi?.priceOut, tin, tout)
    this.budget.record({ session: `ts:${this.conv}`, model, tokensIn: tin, tokensOut: tout, measured, usd, rate: this.st.prefs.rate ?? null, note })
    this.emit({ type: "usage", input: tin, output: tout, measured, usd })
  }

  /** Contenu d'un message utilisateur avec images, si le modèle sait les lire ; sinon le texte seul, avec un avis. */
  private userContent(text: string, images: PastedImage[], canRead: boolean): Msg["content"] {
    if (!images.length) return text
    if (!canRead) {
      this.emit({ type: "notice", text: "Ce modèle ne lit pas les images : message envoyé sans elles. Choisis un modèle qui accepte les images.", level: "warn" })
      return text
    }
    return [{ type: "text", text }, ...images.map((im) => ({ type: "image_url" as const, image_url: { url: im.dataUrl } }))]
  }

  /** Dépose les images dans le projet et renvoie la phrase qui les indique à l'agent. */
  private saveImages(images: PastedImage[]): string {
    return `\n\nImages jointes par l'utilisateur (dans le projet) : ${writeImages(this.cwd, images).join(", ")}`
  }


  private async api(text: string, space: Space, canvas?: string | null, images: PastedImage[] = []): Promise<string> {
    const c = this.st.current
    if (!c || c.kind !== "api") throw new Error(space === "work" ? "Choisissez un modèle d'API ou un agent pour l'espace Work." : "Choisissez un modèle d'API (les agents travaillent dans l'espace Work).")
    const p = provider(c.provider)!
    const mi = this.modelInfo(c)
    const blocked = this.budget.blocked(c.model!)
    if (blocked) throw new Error(`Envoi bloqué : ${blocked}`)
    const memCtx = this.mem.context(this.district, text)
    const extra: Record<string, unknown> = { ...(this.st.prefs.options?.[`${c.provider}/${c.model}`] ?? {}) }
    const lv = this.st.prefs.effort?.[`${c.provider}/${c.model}`]
    const ev = lv ? levelValue(mi?.effort, lv) : undefined
    if (ev && mi?.effortParam) extra[mi.effortParam] = ev
    const useTools = space === "work" && (mi ? mi.tools !== false : c.provider !== "poe") // bot Poe hors catalogue : sans outils
    const env: ToolEnv = { roots: [this.cwd], perms: this.perms, memory: this.mem, districtId: this.district, todos: this.todos, signal: this.abort!.signal,
                           sandbox: this.st.prefs.sandbox !== false, skills: this.skills, mcp: this.mcp } // les outils appliquent sandboxFor
    // canevas actif : la règle, et la version actuelle du document (éventuellement retouchée à la main par l'utilisateur)
    const canvasPart = canvas === undefined ? "" : "\n\n" + CANVAS_RULE + (canvas ? `\n\nVersion actuelle du canevas :\n\`\`\`html\n${canvas.slice(0, 60_000)}\n\`\`\`` : "")
    // le catalogue dit si le modèle lit les images ; s'il ne dit rien (bot Poe, serveur local…), on essaie
    const canRead = !mi || !mi.input?.length || mi.input.includes("image")
    const msgs: Msg[] = [{ role: "system", content: this.system(space, useTools, memCtx.text) + canvasPart }, ...this.history, { role: "user", content: this.userContent(text, images, canRead) }]
    if (memCtx.used.length) this.emit({ type: "notice", text: `Mémoire : ${memCtx.used.length} élément(s) utilisé(s)`, level: "info" })
    let final = ""
    let tin = 0, tout = 0, measured = false
    const snaps = useTools ? new Snapshots(this.cwd) : null
    const before = snaps ? await snaps.snapshot(`avant : ${text.slice(0, 60)}`) : null
    for (let step = 0; step < 40 && !this.abort!.signal.aborted; step++) {
      let stepText = ""
      let calls: { id: string; name: string; args: string }[] = []
      const mediaOnly = !!mi?.output && !mi.output.includes("text")
      for await (const e of streamChat(p, c.model!, msgs, { signal: this.abort!.signal, extra, tools: useTools && !mediaOnly ? openAiTools(env) : undefined, noStream: mediaOnly })) {
        if (e.type === "text") {
          stepText += e.text
          this.emit({ type: "text", text: e.text })
        } else if (e.type === "thinking") this.emit({ type: "thinking", text: e.text })
        else if (e.type === "usage") {
          measured = true
          tin += e.input ?? 0
          tout += e.output ?? 0
        } else if (e.type === "tools") calls = useTools && !mediaOnly ? e.calls : [] // outils non proposés : aucun appel n'est exécuté
        else if (e.type === "error") throw new Error(e.message)
      }
      if (stepText) final += (final ? "\n\n" : "") + stepText
      if (!calls.length) break
      msgs.push({ role: "assistant", content: stepText || null, tool_calls: calls.map((x) => ({ id: x.id, type: "function", function: { name: x.name, arguments: x.args } })) })
      for (const call of calls) {
        let args: any = {}
        try {
          args = JSON.parse(call.args || "{}")
        } catch {}
        this.emit({ type: "tool", id: call.id, name: call.name, summary: summarize(call.name, args), done: false })
        const r = await runTool(env, call)
        this.emit({ type: "tool", id: call.id, name: call.name, summary: summarize(call.name, args), done: true, ok: r.ok, output: r.output.slice(0, 4000), diff: r.diff })
        msgs.push({ role: "tool", tool_call_id: call.id, content: r.output.slice(0, 30_000) })
        if (!READ_ONLY_TOOLS.has(call.name)) this.emit({ type: "state" })
      }
    }
    if (!measured) {
      tin = estimateTokens(msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"))
      tout = estimateTokens(final)
    }
    this.record(c.model!, tin, tout, measured, mi, c.provider)
    if (snaps && before) {
      const after = await snaps.snapshot("après")
      if (after && (await snaps.changed(before, after))) this.emit({ type: "notice", text: "Fichiers modifiés dans le projet.", level: "info" })
    }
    return final
  }

  private agentPower(id: string): Power {
    const a = this.st.prefs.agents?.[id] ?? {}
    return agentPowerFor(this.perms.mode, this.perms.bypassVerified, a.power ?? (id === "codex" ? "commandes" : "modifications"), id)
  }

  private async agent(id: string, text: string): Promise<string> {
    const d = this.detected.find((x) => x.id === id)
    if (!d?.installed) throw new Error(`${id} n'est pas installé — ${d?.install ?? ""}`)
    const a = this.st.prefs.agents?.[id] ?? {}
    const memCtx = this.mem.context(this.district, text)
    let final = ""
    let tin = 0, tout = 0, measured = false
    for await (const e of runAgent({ agent: id, binary: d.path!, cwd: this.cwd, prompt: text, model: a.model, effort: a.effort, power: this.agentPower(id),
                                     resume: this.agentSessions[id], system: ["Tu travailles dans Eclipse (desktop). Réponds en français, sans emoji.", memCtx.text].filter(Boolean).join("\n\n"),
                                     signal: this.abort!.signal, sandbox: sandboxFor(this.perms.mode, this.st.prefs.sandbox !== false), subagents: this.st.prefs.cgSubagents !== false })) {
      if (e.type === "session") this.agentSessions[id] = e.id
      else if (e.type === "text") {
        if (!e.parent) final += (final ? "\n\n" : "") + e.text
        this.emit({ type: "text", text: e.text + "\n\n", who: d.label, parent: e.parent })
      } else if (e.type === "thinking") this.emit({ type: "thinking", text: e.text, who: d.label })
      else if (e.type === "tool") this.emit({ type: "tool", id: e.id, name: e.name, summary: e.summary, done: e.done, ok: e.ok, output: e.output, who: d.label, parent: e.parent })
      else if (e.type === "subagent") this.emit({ type: "subagent", agent: id, id: e.id, label: e.label, done: e.done, ok: e.ok, output: e.output })
      else if (e.type === "usage") {
        measured = true
        tin += e.input
        tout += e.output
      } else if (e.type === "error") this.emit({ type: "notice", text: e.message, level: "error" })
    }
    this.record(`cli:${id}`, tin || estimateTokens(text), tout || estimateTokens(final), measured, undefined, d.label)
    return final
  }

  private async cg(text: string): Promise<string> {
    const cfgs: Record<string, any> = {}
    for (const a of ["claude", "codex"] as CgAgent[]) {
      const d = this.detected.find((x) => x.id === a)
      const s = this.st.prefs.agents?.[a] ?? {}
      if (d?.installed) cfgs[a] = { binary: d.path!, model: s.model, effort: s.effort, power: this.agentPower(a) }
    }
    const snaps = new Snapshots(this.cwd)
    const sup = await snaps.unsupported()
    const r = await cgTurn({
      text, cwd: this.cwd, agents: cfgs, lead: this.st.prefs.cgLead ?? "codex", sessions: this.cgSessions, memory: this.mem.context(this.district, text).text,
      sandbox: sandboxFor(this.perms.mode, this.st.prefs.sandbox !== false), signal: this.abort!.signal, mode: (this.st.prefs.cgMode ?? "auto") as CgMode, review: this.st.prefs.cgReview !== false,
      subagents: this.st.prefs.cgSubagents !== false, snapshot: sup ? undefined : (l) => snaps.snapshot(l), diff: sup ? undefined : (a, b) => snaps.diff(a, b),
    }, {
      phase: (phase) => this.emit({ type: "cg", phase }),
      status: (agent, status) => this.emit({ type: "cg", status: { agent, status } }),
      event: (a, e) => {
        const who = CG_LABEL[a]
        if (e.type === "text") this.emit({ type: "text", text: e.text, who, parent: e.parent })
        else if (e.type === "thinking") this.emit({ type: "thinking", text: e.text, who })
        else if (e.type === "tool") this.emit({ type: "tool", id: e.id, name: e.name, summary: e.summary, done: e.done, ok: e.ok, output: e.output, who, parent: e.parent })
        else if (e.type === "subagent") this.emit({ type: "subagent", agent: a, id: e.id, label: e.label, done: e.done, ok: e.ok, output: e.output })
        else if (e.type === "error") this.emit({ type: "notice", text: e.message, level: "error" })
      },
    })
    for (const a of ["claude", "codex"] as CgAgent[]) {
      const u = r.usage[a]
      if (u) this.record(`cli:${a}`, u.input, u.output, true, undefined, "/cg desktop")
    }
    return r.markdown
  }

  private async media(text: string, m?: { provider: string; id: string }, images: PastedImage[] = []): Promise<string> {
    if (!m) throw new Error("Choisissez un modèle d'image, de vidéo ou de son.")
    const p = provider(m.provider)!
    let out = ""
    let tin = 0, tout = 0
    const info = this.models[m.provider]?.find((x) => x.id === m.id)
    const mediaOnly = !info?.output || !info.output.includes("text")
    const canRead = !info || !info.input?.length || info.input.includes("image")
    for await (const e of streamChat(p, m.id, [{ role: "user", content: this.userContent(text, images, canRead) }], { signal: this.abort!.signal, noStream: mediaOnly })) {
      if (e.type === "text") {
        out += e.text
        this.emit({ type: "text", text: e.text, who: m.id })
      } else if (e.type === "usage") {
        tin = e.input ?? 0
        tout = e.output ?? 0
      } else if (e.type === "error") throw new Error(e.message)
    }
    this.record(m.id, tin, tout, !!(tin || tout), this.models[m.provider]?.find((x) => x.id === m.id), `${m.provider} · médias`)
    return out
  }

  /** Nom de projet proposé à partir d'une demande. */
  proposeProject(text: string): string {
    return slug(text)
  }

  async agentModelList(id: string) {
    const d = this.detected.find((x) => x.id === id)
    return d?.installed ? agentModels(id, d.path!) : []
  }

  close(): void {
    this.interrupt()
    this.mcp.stopAll()
    this.mem.close()
    this.budget.close()
  }
}
