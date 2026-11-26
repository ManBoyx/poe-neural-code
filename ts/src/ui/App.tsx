/** Interface d'Eclipse, disposition façon OpenCode : accueil centré, fil de discussion, zone de saisie, barre du bas. */
import { batch, createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { detect, type Detected } from "../core/detect"
import { catalog, keyFor, provider, PROVIDERS, verifyKey, type ModelInfo } from "../core/providers"
import { run as secretRun, setKey, SERVICE, storageName } from "../core/secrets"
import { streamChat, type Msg } from "../core/chat"
import { choose, load, save, type Choice, type State } from "../core/store"
import { dataDir, home, short } from "../core/paths"
import { COMMANDS, resolve, suggest } from "../core/commands"
import { estimateTokens, KIND_LABEL, Memory, rememberRequest, type Hit } from "../core/memory"
import { LEVELS, levelValue } from "../core/effort"
import { runCmd } from "../core/proc"
import { Budget, estimateUsd } from "../core/budget"
import { UsageScreen } from "./UsageScreen"
import { TextPrompt } from "./TextPrompt"
import { PermissionPrompt, revealHidden } from "./PermissionPrompt"
import { Permissions, PERM_LABEL, type Decision, type PermMode, type Request } from "../core/permissions"
import { openAiTools, READ_ONLY_TOOLS, runTool, summarize, type Todo, type ToolEnv } from "../core/tools"
import { Snapshots } from "../core/snapshots"
import { verifyPassword } from "../core/auth"
import * as V from "../core/voice"
import { isProtected, listProjects, needsProject, openProject, projectsRoot, PROTECT_RULE, slug } from "../core/protect"
import { available as sandboxAvailable } from "../core/sandbox"
import { approveFingerprint as approveMcpFingerprint, McpManager, pendingProject, revoke as revokeMcp } from "../core/mcp"
import { discoverPlugins, discoverSkills, loadPlugins, setTrust, skillCatalog, type PluginCommand, type PluginInfo, type Skill } from "../core/extensions"
import { cgTurn, CG_LABEL, parsePlan, type CgAgent, type CgMode } from "../core/cg"
import { CgZones, cgTabs, SUB_COLORS, SubAgentView, type Zone, type ZoneEntry } from "./CgView"
import { CgMenu } from "./CgMenu"
import { type AgentModel, agentModels, AGENT_SUPPORT, POWER_LABEL, runAgent, type Power } from "../core/agents"
import { coerce } from "../core/providers"
import { VERSION, VERSION_INFO } from "../core/version"
import { Picker, type ProviderStatus } from "./Picker"
import { KeyPrompt } from "./KeyPrompt"
import { ListPicker, type ListEntry } from "./ListPicker"
import { autoDetect, C, I, iconSet, mdStyles, setIcons, setTheme, THEME_LABEL, themeName, type ThemeName } from "./theme"
import { getLang, setLang, t, type Lang } from "./i18n"

export { VERSION }

interface Item {
  role: "user" | "assistant" | "notice" | "tool"
  tool?: string
  ok?: boolean
  running?: boolean
  output?: string
  diff?: string
  text: string
  thinking?: string
  meta?: string
  memory?: string
  level?: "info" | "warn" | "error"
  streaming?: boolean
  aside?: boolean
  archiveId?: number
}

type Overlay =
  | null
  | { type: "models"; view?: string }
  | { type: "key"; id: string }
  | { type: "list"; title: string; entries: () => ListEntry[]; onPick: (v: string) => void; hint?: string }
  | { type: "usage" }
  | { type: "text"; title: string; note?: string; initial?: string; onSubmit: (v: string) => void }
  | { type: "perm"; req: Request; resolve: (d: Decision) => void }
  | { type: "cgmenu" }
  | { type: "sub"; agent: CgAgent; id: string }

/** Commandes refusées pendant une réponse : elles enverraient un message ou changeraient de discussion. */
const BUSY_BLOCKED = new Set(["retry", "edit", "btw", "init", "review", "goal", "compact", "verify", "new", "sessions", "open", "cd", "fork", "undo", "redo", "cg", "restart"])
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

const LOGO = [
  "█▀▀▀ █▀▀█ █    ▀█▀ █▀▀█ █▀▀▀ █▀▀▀",
  "█▀▀▀ █    █     █  █▀▀▀ ▀▀▀█ █▀▀▀",
  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀ ▀    ▀▀▀▀ ▀▀▀▀",
]

const HIGHLIGHTS = `# Eclipse 5 (en cours)
- Réécrit en TypeScript (Bun + OpenTUI), disposition façon OpenCode.
- Aucun fournisseur imposé : récents, API recommandées, agents détectés, recherche dans tous les catalogues.
- Poe : 200 modèles reconnus au lieu de 36 ; clé vérifiée pour de vrai, /connect reproposé si elle est refusée.
- Mémoire refaite : recherche sans accents, mémoire montrée à chaque message, « retiens que … ».
- Thèmes contraste élevé, clair et sans couleur (NO_COLOR) ; icônes en texte si la police manque ; français et anglais.
- Commandes d'Eclipse et d'OpenCode réunies, sans doublon (/help).`

/** « 30m », « 5h », « 1d », « 1w » -> secondes ; null si illisible. */
export function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)\s*(m|min|h|d|j|w|s)$/i)
  if (!m) return null
  return Number(m[1]) * ({ s: 1, m: 60, min: 60, h: 3600, d: 86400, j: 86400, w: 604800 } as Record<string, number>)[m[2].toLowerCase()]
}

function systemPrompt(mode: "build" | "plan", lang: Lang, cwd: string, tools = false, perm = "demander"): string {
  const fr = lang === "fr"
  return [
    fr ? "Tu es Eclipse, un assistant de programmation dans un terminal." : "You are Eclipse, a programming assistant in a terminal.",
    fr ? `Dossier de travail : ${cwd}.` : `Working folder: ${cwd}.`,
    fr ? "Réponds en français, clairement, en Markdown, sans aucune emoji." : "Answer in English, clearly, in Markdown, without any emoji.",
    tools
      ? (fr ? `Tu as des outils pour lire, chercher, modifier les fichiers du projet et lancer des commandes. Lis avant de modifier ; préfère edit_file pour une petite modification. Permissions actuelles : ${perm}. Si une action est refusée, ne la contourne pas : explique et propose.`
            : `You have tools to read, search and change project files and run commands. Read before editing; prefer edit_file for small changes. Current permissions: ${perm}. If an action is refused, do not work around it: explain and propose.`)
      : (fr ? "Tu n'as pas d'outils avec ce modèle : tu ne peux ni lire ni modifier les fichiers toi-même ; dis-le si on te le demande."
            : "You have no tools with this model: you cannot read or change files yourself; say so if asked."),
    mode === "plan"
      ? (fr ? "Mode plan : lecture seule. Analyse et propose un plan, sans rien modifier." : "Plan mode: read-only. Analyse and propose a plan, without changing anything.")
      : "",
    PROTECT_RULE,
  ].filter(Boolean).join("\n")
}

export function App(props: { cwd: string }) {
  const renderer = useRenderer()
  const dims = useTerminalDimensions()

  const [st, setSt] = createSignal<State>(load())
  autoDetect({ theme: st().prefs.theme, icons: st().prefs.icons })
  if (st().prefs.lang) setLang(st().prefs.lang!)
  const [ui, setUi] = createSignal(0) // change de thème ou de langue : l'écran est redessiné en entier
  const md = createMemo(() => (ui(), SyntaxStyle.fromStyles(mdStyles() as any, renderer.nativeScene as any)))

  const [cwd, setCwd] = createSignal(props.cwd)
  const mem = new Memory()
  const budget = new Budget()
  const [district, setDistrict] = createSignal(mem.district(props.cwd))
  let conv: number | null = null
  const [title, setTitle] = createSignal("")

  const [detected, setDetected] = createSignal<Detected[]>([])
  const [status, setStatus] = createStore<Record<string, ProviderStatus>>({})
  const [items, setItems] = createStore<Item[]>([])
  const [overlay, setOverlay] = createSignal<Overlay>(null)
  const [busy, setBusy] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [leader, setLeader] = createSignal(false)
  const [exitArmed, setExitArmed] = createSignal(0)
  const [toast, setToast] = createSignal("")
  const [usage, setUsage] = createStore<Record<string, { in: number; out: number; turns: number }>>({})
  let prompt: TextareaRenderable | undefined
  let threadScroll: any
  const perms = new Permissions((req) => new Promise<Decision>((res) => later({ type: "perm", req, resolve: res })))
  const [permMode, setPermMode] = createSignal<PermMode>("demander")
  const [extraDirs, setExtraDirs] = createSignal<string[]>([])
  const [todos, setTodos] = createStore<Todo[]>([])
  const todoList: Todo[] = []
  const syncTodos = () => setTodos(todoList.map((x) => ({ ...x })))
  const undoStack: { before: string; label: string }[] = []
  const redoStack: { after: string; label: string }[] = []
  const [goal, setGoal] = createSignal<{ text: string; active: boolean; rounds: number } | null>(null)
  const [attachments, setAttachments] = createSignal<string[]>([])
  const [showDetails, setShowDetails] = createSignal(true)
  const agentSessions: Record<string, string> = {} // agent -> identifiant de sa session (reprise d'un message à l'autre)
  const noTools = new Set<string>()
  const [usageTick, setUsageTick] = createSignal(0)
  const [spin, setSpin] = createSignal(0)
  const [activity, setActivity] = createSignal("")
  const [busySince, setBusySince] = createSignal(0)
  let spinTimer: ReturnType<typeof setInterval> | null = null
  createEffect(on(busy, (b) => {
    if (b && !spinTimer) {
      setBusySince(Date.now())
      spinTimer = setInterval(() => setSpin((x) => x + 1), 100)
    } else if (!b && spinTimer) {
      clearInterval(spinTimer)
      spinTimer = null
      setActivity("")
    }
  }))
  const spinner = () => SPIN[spin() % SPIN.length]
  const elapsed = () => {
    spin()
    const s = Math.floor((Date.now() - busySince()) / 1000)
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`
  }
  // /cg : discussion commune Claude Code et Codex
  const [cgOn, setCgOn] = createSignal(false)
  const [cgPhase, setCgPhase] = createSignal("")
  const [cgTab, setCgTab] = createSignal("ensemble")
  let beforeCg: number | null = null
  const warnedSnap = new Set<string>()
  // appel vocal (/voice) : écoute, transcription locale, réponse lue à voix haute, puis réécoute
  const [voiceOn, setVoiceOn] = createSignal(false)
  const [voiceState, setVoiceState] = createSignal<"écoute" | "transcription" | "réponse" | "lecture">("écoute")
  const [voiceLevel, setVoiceLevel] = createSignal(0)
  let voiceListener: { stop: () => void; pause: (on: boolean) => void } | null = null
  let stopSpeech: (() => void) | null = null

  function hangUp(msg = "Appel vocal terminé.") {
    voiceListener?.stop()
    voiceListener = null
    stopSpeech?.()
    stopSpeech = null
    setVoiceOn(false)
    note(msg)
  }

  async function onUtterance(pcm: Int16Array, s: V.VoiceSetup) {
    if (!voiceOn() || voiceState() !== "écoute") return
    voiceListener?.pause(true)
    setVoiceState("transcription")
    const r = await V.transcribe(s, pcm, getLang())
    if (!voiceOn()) return
    if (!r.ok || !r.text || r.text.length < 2) {
      if (!r.ok) note(`Voix : ${r.reason}`, "warn")
      setVoiceState("écoute")
      return voiceListener?.pause(false)
    }
    if (/^(raccroche|fin de l'appel|termine l'appel|au revoir)\.?$/i.test(r.text.trim())) return hangUp()
    setVoiceState("réponse")
    const before = items.length
    await send(r.text)
    if (!voiceOn()) return
    // réponse lue à voix haute : dernière réponse de ce tour
    const answer = items.slice(before).filter((x) => x.role === "assistant" && x.text && x.level !== "error").map((x) => x.text).join("\n\n")
    const speech = V.speakable(answer || "Je n'ai pas de réponse à lire. Regardez l'écran.")
    setVoiceState("lecture")
    stopSpeech = V.speak(s, speech, () => {
      stopSpeech = null
      if (!voiceOn()) return
      setVoiceState("écoute")
      voiceListener?.pause(false)
    })
  }

  async function startVoice() {
    const s = V.setup(prefs().voiceModel)
    if (s.missing.length) return note("Voix indisponible :\n" + s.missing.map((m) => "  - " + m).join("\n"), "warn")
    if (busy()) return flash(t("Une réponse est en cours (échap pour interrompre)."))
    setVoiceOn(true)
    setVoiceState("écoute")
    voiceListener = V.listen(s, {
      onUtterance: (pcm) => { onUtterance(pcm, s) },
      onLevel: (l) => setVoiceLevel(l),
      onError: (m) => { if (voiceOn()) hangUp(`Appel vocal arrêté : ${m}`) },
    })
    const who = current()?.kind === "agent" ? agentName(current()!.provider) : cgOn() ? "Claude Code et Codex" : current()?.model ?? "le modèle"
    note(`Appel vocal avec ${who} : parlez, Eclipse transcrit (whisper, sur ce PC), envoie, puis lit la réponse (piper). ` +
         "Échap coupe la voix ou interrompt la réponse · dites « raccroche » ou tapez /voice pour terminer.")
  } // discussion en cours avant d'entrer dans /cg, retrouvée à la sortie
  const emptyZone = (label: string): Zone => ({ status: "en attente", entries: [], input: 0, output: 0, label, subs: [] })
  const [cgModels, setCgModels] = createSignal<Partial<Record<CgAgent, AgentModel[]>>>({})
  /** Ajoute une ligne dans la zone d'un agent, ou dans celle de son sous-agent (parent). */
  function zonePush(a: CgAgent, parent: string | undefined, entry: ZoneEntry) {
    setZones(a, produce((z) => {
      const sub = parent ? z.subs.find((s) => s.id === parent) : undefined
      ;(sub ? sub.entries : z.entries).push(entry)
    }))
  }
  function zoneToolDone(a: CgAgent, parent: string | undefined, text: string, ok?: boolean) {
    setZones(a, produce((z) => {
      const sub = parent ? z.subs.find((s) => s.id === parent) : undefined
      const xs = sub ? sub.entries : z.entries
      for (let i = xs.length - 1; i >= 0; i--) if (xs[i].kind === "tool" && xs[i].running) { xs[i].running = false; xs[i].ok = ok; return }
      xs.push({ kind: "tool", text, ok })
    }))
  }
  const [zones, setZones] = createStore<Record<CgAgent, Zone>>({ claude: emptyZone("Claude Code"), codex: emptyZone("Codex") })
  const cgSessions: Partial<Record<CgAgent, string>> = {}
  const mcp = new McpManager()
  const [mcpTick, setMcpTick] = createSignal(0)
  let skills: Skill[] = []
  let plugins: PluginInfo[] = []
  let pluginCmds: PluginCommand[] = []
  async function loadExtensions() {
    skills = discoverSkills(cwd())
    plugins = discoverPlugins(cwd())
    if (process.platform === "linux" && !sandboxAvailable().ok && !warnedNoBwrap) {
      warnedNoBwrap = true
      note("bubblewrap n'est pas installé : sandbox et garde des fichiers d'Eclipse indisponibles pour les commandes et les agents (seuls les outils d'Eclipse refusent d'y écrire). Installez le paquet bubblewrap.", "warn")
    }
    pluginCmds = await loadPlugins(plugins)
    const started = mcp.start(cwd(), () => setMcpTick((x) => x + 1)) // statut connu tout de suite, connexions ensuite
    const waiting = mcp.status.filter((x) => x.state === "à approuver")
    if (waiting.length) note(`Ce projet déclare ${waiting.length} serveur(s) MCP (${waiting.map((x) => x.name).join(", ")}) : rien n'est lancé sans votre accord. /mcp pour voir les commandes, puis /mcp approuver NOM.`, "warn")
    await started.catch(() => {})
  }
  let warnedNoBwrap = false
  /** Consignes du projet (AGENTS.md, CLAUDE.md, .eclipse/instructions.md) et personnelles, bornées. */
  function instructions(): string {
    const parts: string[] = []
    if (prefs().system) parts.push(`Consignes personnelles de l'utilisateur :\n${prefs().system}`)
    for (const f of ["AGENTS.md", "CLAUDE.md", ".eclipse/instructions.md"]) {
      const pth = join(cwd(), f)
      if (existsSync(pth)) parts.push(`Consignes du projet (${f}, contenu du dépôt) :\n${readFileSync(pth, "utf8").slice(0, 8000)}`)
    }
    const cat = skillCatalog(skills)
    if (cat) parts.push(cat)
    return parts.join("\n\n")
  }
  /** /fusion : consulter un autre modèle d'API ou un agent, en lecture seule. */
  async function consultHelper(id: string, question: string): Promise<{ ok: boolean; text: string }> {
    if (!(prefs().fusion ?? []).includes(id)) return { ok: false, text: `assistant inconnu : ${id} (configurés : ${(prefs().fusion ?? []).join(", ") || "aucun"})` }
    if (id.startsWith("agent:")) {
      const d = detected().find((x) => x.id === id.slice(6))
      if (!d?.installed) return { ok: false, text: `${id} n'est pas installé` }
      let text = ""
      for await (const e of runAgent({ agent: d.id, binary: d.path!, cwd: cwd(), prompt: question, power: "lecture", sandbox: sandboxOn(), signal: abort?.signal, idleMs: 120_000 })) {
        if (e.type === "text") text += (text ? "\n\n" : "") + e.text
        if (e.type === "usage") recordUsage({ session: sessionKey(), model: `cli:${d.id}`, tokensIn: e.input, tokensOut: e.output, measured: true, usd: null, note: "/fusion" })
      }
      return { ok: !!text, text: text || "pas de réponse" }
    }
    const [pid, ...mparts] = id.split("/")
    const pv = provider(pid)
    if (!pv) return { ok: false, text: `fournisseur inconnu : ${pid}` }
    let text = ""
    let tin = 0, tout = 0
    for await (const e of streamChat(pv, mparts.join("/"), [{ role: "user", content: question }], { signal: abort?.signal })) {
      if (e.type === "text") text += e.text
      else if (e.type === "usage") { tin = e.input ?? 0; tout = e.output ?? 0 }
      else if (e.type === "error") return { ok: false, text: e.message }
    }
    const mi = status[pid]?.models?.find((m) => m.id === mparts.join("/"))
    recordUsage({ session: sessionKey(), model: mparts.join("/"), tokensIn: tin, tokensOut: tout, measured: !!(tin || tout), usd: estimateUsd(mi?.priceIn, mi?.priceOut, tin, tout), rate: rate(), note: `${pid} · /fusion` })
    return { ok: true, text }
  }
  const recordUsage = (e: Parameters<Budget["record"]>[0]) => {
    budget.record(e)
    setUsageTick((x) => x + 1) // après l'enregistrement : la colonne relit le bon total
  } // modèles qui ont refusé les outils (HTTP 400) : on n'en renvoie plus
  let abort: AbortController | null = null
  let history: Msg[] = []

  const prefs = () => st().prefs
  const updatePrefs = (p: Partial<State["prefs"]>) => {
    const next = { ...st(), prefs: { ...st().prefs, ...p } }
    setSt(next)
    save(next)
    if (p.agents) setTimeout(() => refreshZones(), 0)
  }
  const mode = () => prefs().mode ?? "build"
  const sandboxOn = () => prefs().sandbox !== false && sandboxAvailable().ok
  const sidebarOn = () => prefs().sidebar !== false // affichée par défaut sur un écran assez large
  const sessionKey = () => (conv ? `ts:${conv}` : `ts:pid-${process.pid}`)
  const rate = (): number | null => {
    if (prefs().rate) return prefs().rate!
    try {
      return JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8")).points_per_usd ?? null
    } catch {
      return null
    }
  }

  const flash = (s: string) => {
    setToast(s)
    setTimeout(() => setToast((x) => (x === s ? "" : x)), 3500)
  }
  const later = (o: Overlay) => setTimeout(() => setOverlay(o), 0) // la touche qui ouvre n'est pas reçue deux fois
  const openModels = (view?: string) => later({ type: "models", view })
  const openList = (title: string, entries: () => ListEntry[], onPick: (v: string) => void, hint?: string) => later({ type: "list", title, entries, onPick, hint })
  const closeOverlay = () => {
    setOverlay(null)
    setTimeout(() => prompt?.focus(), 0)
  }

  const current = () => st().current
  const agentName = (id: string) => detected().find((d) => d.id === id)?.label ?? id
  const modelInfo = (c?: Choice): ModelInfo | undefined => (c?.kind === "api" ? status[c.provider]?.models?.find((m) => m.id === c.model) : undefined)
  const effortKey = (c?: Choice) => (c ? `${c.provider}/${c.model ?? ""}` : "")
  const effortLabel = () => {
    const lv = prefs().effort?.[effortKey(current())]
    return lv && modelInfo(current())?.effort ? ` · ${lv}` : ""
  }
  const currentLabel = createMemo(() => {
    const c = current()
    if (!c) return t("aucun modèle — /models")
    if (c.kind === "agent") {
      const a = prefs().agents?.[c.provider] ?? {}
      return `${agentName(c.provider)}${a.model ? " · " + a.model : ""}${a.effort ? " · " + a.effort : ""} · ${a.power ?? "modifications"}`
    }
    return `${c.model} · ${provider(c.provider)?.label ?? c.provider}${effortLabel()}`
  })

  // ------------------------------------------------------------ fournisseurs
  async function loadProvider(id: string, refresh = false) {
    const p = provider(id)
    if (!p) return
    const k = await keyFor(p)
    let key: ProviderStatus["key"] = p.local ? "local" : k.ok ? "ok" : k.missing ? "missing" : "error"
    let keyNote = p.local ? p.baseUrl : k.ok ? `clé : ${k.source}` : k.missing ? "clé à saisir" : k.reason
    setStatus(id, { key, keyNote, loading: key === "ok" || key === "local" })
    if (key === "ok") {
      // vérification réelle : une clé supprimée ou modifiée chez le fournisseur est détectée au lancement
      const v = await verifyKey(p)
      if (v.check === "refusée") {
        key = "invalid"
        keyNote = v.detail
      } else if (v.check === "non vérifiée") keyNote += ` · ${v.detail}`
      setStatus(id, { key, keyNote, loading: key === "ok" })
      if (key === "invalid") return needKey(id)
    }
    if (key !== "ok" && key !== "local") return
    const r = await catalog(p, { refresh })
    setStatus(id, r.ok ? { key, keyNote, models: r.models, loading: false, error: undefined } : { key, keyNote, loading: false, error: r.reason })
  }

  /** Repropose /connect : clé absente, supprimée ou modifiée (fournisseur utilisé ou recommandé). */
  function needKey(id: string, force = false) {
    const c = st().current
    // seulement pour le fournisseur utilisé (ou au premier lancement, pour un recommandé) : jamais par-dessus un autre choix
    if (!force && !(c?.kind === "api" && c.provider === id) && !(!c && provider(id)?.recommended)) return
    if (overlay()?.type === "key") return
    later({ type: "key", id })
  }

  function refreshAll(refresh = false) {
    for (const p of PROVIDERS) {
      if (p.recommended || p.local) loadProvider(p.id, refresh)
      else keyFor(p).then((k) => (k.ok ? loadProvider(p.id, refresh) : setStatus(p.id, { key: k.missing ? "missing" : "error", keyNote: k.missing ? "clé à saisir" : k.reason })))
    }
    return detect({ withVersion: true, manual: st().agentPaths, refresh }).then((d) => (setDetected(d), d))
  }

  onMount(() => {
    refreshAll()
    loadExtensions()
    // automatisations : vérifiées toutes les 20 s, lancées seulement quand Eclipse est libre
    setInterval(() => {
      if (busy() || overlay()) return
      const due = (prefs().automations ?? []).find((a) => !a.paused && Date.now() - (a.last ?? 0) >= a.every * 1000)
      if (!due) return
      updatePrefs({ automations: (prefs().automations ?? []).map((a) => (a.id === due.id ? { ...a, last: Date.now() } : a)) })
      note(`Automatisation n° ${due.id} (toutes les ${Math.round(due.every / 60)} min) :`, "info")
      send(due.prompt)
    }, 20_000)
    if (!st().current) openModels() // premier lancement : aucun fournisseur n'est imposé
  })

  const refreshZones = () => { for (const a of ["claude", "codex"] as CgAgent[]) setZones(a, "label", zoneLabel(a)) }

  function pick(c: Choice) {
    const next = choose(st(), c)
    setSt(next)
    save(next)
    closeOverlay()
    flash(`${t("Modèle")} → ${c.model ?? agentName(c.provider)}`)
  }

  // ------------------------------------------------------------ discussion
  function note(text: string, level: Item["level"] = "info") {
    setItems(items.length, { role: "notice", text, level })
  }

  function ensureConv(firstText: string): number {
    if (conv) return conv
    const tt = (cgOn() ? "[cg] " : "") + firstText.replace(/\s+/g, " ").slice(0, 60)
    conv = mem.newConversation(district(), tt)
    setTitle(tt)
    return conv
  }

  function newChat() {
    for (const k of Object.keys(agentSessions)) delete agentSessions[k]
    setItems([])
    history = []
    conv = null
    setTitle("")
  }

  function loadConversation(id: number) {
    const tt = (mem.db.query("SELECT title FROM conversations WHERE id=?").get(id) as { title: string } | null)?.title ?? ""
    if (tt.startsWith("[cg]") !== cgOn()) setCgOn(tt.startsWith("[cg]")) // une discussion /cg se rouvre dans /cg, une autre hors de /cg
    const msgs = mem.messages(id)
    const row = mem.db.query("SELECT title, district_id FROM conversations WHERE id=?").get(id) as { title: string; district_id: number } | null
    batch(() => {
      newChat()
      conv = id
      setTitle(row?.title || `Session ${id}`)
      if (row) setDistrict(row.district_id)
      setItems(msgs.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as Item["role"], text: m.content, archiveId: m.id })))
    })
    for (const m of msgs) {
      try {
        const meta = JSON.parse(m.meta || "{}")
        if (meta.agent && meta.agentSession) agentSessions[meta.agent] = meta.agentSession
      } catch {}
    }
    history = msgs.filter((m) => m.role === "user" || m.role === "assistant").slice(-40).map((m) => ({ role: m.role as Msg["role"], content: m.content }))
    flash(`Session reprise : ${msgs.length} échanges`)
  }

  /** Pièces jointes et références @chemin : texte ajouté au message, images en ligne si le modèle les accepte. */
  function buildUserContent(text: string, mi?: ModelInfo): { content: string | Msg["content"]; notes: string[] } {
    const notes: string[] = []
    const files = [...attachments(), ...[...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1])]
    const parts: any[] = [{ type: "text", text }]
    let extraText = ""
    for (const f of [...new Set(files)]) {
      const abs = resolvePath(cwd(), f.replace(/^~/, home()))
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        if (attachments().includes(f)) notes.push(`pièce jointe introuvable : ${f}`)
        continue
      }
      if (/\.(png|jpe?g|webp|gif)$/i.test(abs)) {
        if (!mi?.input?.includes("image") && !mi?.output?.includes("image")) { // un modèle d'image peut retoucher l'image jointe
          notes.push(`${short(abs)} : ce modèle n'annonce pas les images, non envoyée`)
          continue
        }
        const mime = abs.toLowerCase().endsWith(".png") ? "image/png" : abs.toLowerCase().endsWith(".webp") ? "image/webp" : abs.toLowerCase().endsWith(".gif") ? "image/gif" : "image/jpeg"
        parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${readFileSync(abs).toString("base64")}` } })
        notes.push(`image jointe : ${short(abs)}`)
      } else if (statSync(abs).size <= 200_000) {
        extraText += `\n\n--- Fichier ${short(abs)} ---\n${readFileSync(abs, "utf8")}`
        notes.push(`fichier joint : ${short(abs)}`)
      } else notes.push(`${short(abs)} : trop gros pour être joint (plus de 200 ko) — le modèle peut le lire avec ses outils`)
    }
    setAttachments([])
    if (parts.length > 1) {
      parts[0].text += extraText
      return { content: parts, notes }
    }
    return { content: text + extraText, notes }
  }

  /** Tour d'un agent CLI : sortie lue au fil de l'eau, outils de l'agent montrés, session reprise au message suivant. */
  async function askAgent(id: string, text: string, opts: { aside?: boolean; readOnly?: boolean } = {}) {
    const d = detected().find((x) => x.id === id)
    if (!d?.installed) return note(`${agentName(id)} n'est pas installé — ${d?.install ?? ""}`, "error")
    if (!AGENT_SUPPORT[id]) return note(`${d.label} n'est pas encore pilotable depuis Eclipse (Claude Code, Codex, OpenCode et Gemini le sont).`, "warn")
    const a = prefs().agents?.[id] ?? {}
    let power: Power = opts.readOnly || mode() === "plan" || perms.mode === "lecture" ? "lecture" : (a.power ?? "modifications")
    if (perms.mode.startsWith("bypass") && perms.bypassVerified && power !== "lecture") power = "bypass"
    const blocked = budget.blocked(`cli:${id}`)
    if (blocked) return note(`Envoi bloqué : ${blocked}.`, "error")
    if (AGENT_SUPPORT[id] === "non vérifié") note(`${d.label} : pilotage par sa sortie texte, pas encore vérifié par un vrai essai.`, "warn")
    const memCtx = mem.context(district(), text)
    const system = [getLang() === "fr" ? "Tu travailles dans Eclipse, qui affiche ta réponse à l'utilisateur. Réponds en français, sans aucune emoji." : "You are running inside Eclipse, which shows your answer to the user. No emoji.",
                    memCtx.text].filter(Boolean).join("\n\n")
    const uc = buildUserContent(text)
    for (const n of uc.notes) note(n, "info")
    setBusy(true)
    abort = new AbortController()
    const signal = abort.signal
    const snaps = power !== "lecture" && !opts.aside ? new Snapshots(cwd()) : null
    const before = snaps ? await snaps.snapshot(`avant : ${text.slice(0, 60)}`) : null
    const idx = items.length
    setItems(idx, { role: "assistant", text: "", streaming: true, aside: opts.aside,
                    memory: memCtx.used.length ? `${I.memory} ${t("Mémoire")} : ${memCtx.used.length} ${t("éléments utilisés")}` : undefined })
    const toolIdx = new Map<string, number>()
    let tin = 0, tout = 0, cost: number | undefined, measured = false, touched = false, failed = false
    let cur = idx
    const t0 = Date.now()
    for await (const e of runAgent({ agent: id, binary: d.path!, cwd: cwd(), prompt: typeof uc.content === "string" ? uc.content : text, model: a.model, effort: a.effort,
                                     power, resume: opts.aside ? undefined : agentSessions[id], system, signal, sandbox: sandboxOn(), idleMs: 180_000 })) {
      if (e.type === "session") { if (!opts.aside) agentSessions[id] = e.id; setActivity(`${d.label} réfléchit`) }
      else if (e.type === "tool" && !e.done) setActivity(`${d.label} · ${e.name} ${e.summary.slice(0, 40)}`)
      else if (e.type === "subagent" && !e.done) setActivity(`${d.label} · sous-agent : ${e.label.slice(0, 40)}`)
      else if (e.type === "text") {
        if (items[cur]?.role !== "assistant") {
          cur = items.length
          setItems(cur, { role: "assistant", text: "", streaming: true, aside: opts.aside })
        }
        setItems(cur, "text", (x) => (x ? x + (id === "claude" || id === "codex" ? "\n\n" : "") : "") + e.text)
      } else if (e.type === "thinking") setItems(cur, "thinking", (x) => (x ?? "") + e.text)
      else if (e.type === "subagent") {
        cur = -1
        if (!e.done) {
          toolIdx.set(e.id, items.length)
          setItems(items.length, { role: "tool", tool: `${d.label} · sous-agent`, text: e.label, running: true })
        } else {
          const ti = toolIdx.get(e.id)
          if (ti !== undefined) setItems(ti, produce((it) => { it.running = false; it.ok = e.ok; it.output = e.output }))
        }
      } else if (e.type === "tool") {
        cur = -1 // le texte qui suit l'outil s'affiche en dessous de lui
        if (!e.done) {
          const ti = items.length
          toolIdx.set(e.id, ti)
          setItems(ti, { role: "tool", tool: `${d.label} · ${e.name}`, text: e.summary, running: true })
        } else {
          const ti = toolIdx.get(e.id) ?? items.length
          if (!toolIdx.has(e.id)) setItems(ti, { role: "tool", tool: `${d.label} · ${e.name}`, text: e.summary })
          setItems(ti, produce((it) => { it.running = false; it.ok = e.ok; it.output = e.output; if (e.summary) it.text = e.summary }))
          if (e.ok && /edit|write|fichiers|commande|bash/i.test(e.name)) touched = true
        }
      } else if (e.type === "usage") {
        measured = true
        tin += e.input
        tout += e.output
        if (e.costUsd != null) cost = (cost ?? 0) + e.costUsd
      } else if (e.type === "error") {
        failed = true
        setItems(items.length, { role: "notice", text: e.message, level: "error" })
      }
    }
    for (let i = idx; i < items.length; i++) if (items[i].role === "assistant") setItems(i, "streaming", false)
    if (snaps && before) {
      const after = await snaps.snapshot(`après : ${text.slice(0, 60)}`)
      touched = !!after && (await snaps.changed(before, after))
    }
    if (!items[idx]?.text && !items[idx]?.thinking) setItems((xs) => xs.filter((_, i) => i !== idx || xs[i].role !== "assistant"))
    const interrupted = signal.aborted
    abort = null
    const s = (Date.now() - t0) / 1000
    const finalText = items.filter((x, i) => i >= idx && x.role === "assistant").map((x) => x.text).join("\n\n")
    if (!measured) { tin = estimateTokens(text); tout = estimateTokens(finalText) }
    recordUsage({ session: sessionKey(), model: `cli:${id}`, tokensIn: tin, tokensOut: tout, measured, usd: null, note: `${d.label}${cost != null ? ` · équivalent API ${cost.toFixed(4)} $` : ""}` })
    batch(() => {
      setItems(items.length, { role: "notice", level: "info", text: `${power === "lecture" ? "Plan" : "Build"} · ${d.label}${a.model ? " · " + a.model : ""} · ${power} · ${s.toFixed(1)} s · ↓${tin} ↑${tout} tok${measured ? "" : " (estimés)"}` +
        (cost != null ? ` · équivalent API ≈ $${cost.toFixed(4)} (abonnement)` : "") + (interrupted ? ` · ${t("interrompu")}` : "") + (touched ? " · fichiers modifiés : /undo pour annuler" : "") })
      setBusy(false)
    })
    if (touched && before) {
      undoStack.push({ before, label: text.slice(0, 60) })
      redoStack.length = 0
    }
    if (opts.aside || !finalText || failed && !finalText) return
    history.push({ role: "user", content: text }, { role: "assistant", content: finalText })
    const aid = mem.append(ensureConv(text), "assistant", finalText, { agent: id, agentSession: agentSessions[id], model: a.model, interrupted })
    for (let i = items.length - 1; i >= 0; i--) if (items[i].role === "assistant") { setItems(i, "archiveId", aid); break }
  }

  const zoneLabel = (a: CgAgent) => {
    const s = prefs().agents?.[a] ?? {}
    return `${CG_LABEL[a]}${s.model ? " · " + s.model : ""}${s.effort ? " · " + s.effort : ""} · ${s.power ?? (a === "codex" ? "commandes" : "modifications")}`
  }

  /** Quitte /cg (/new ou /cg off) : retour au mode normal et à la discussion d'avant, s'il y en avait une. */
  function leaveCg() {
    if (busy()) return flash(t("Une réponse est en cours (échap pour interrompre)."))
    setCgOn(false)
    const back = beforeCg
    beforeCg = null
    if (back) {
      loadConversation(back)
      return note("Sortie de /cg : retour à votre discussion précédente. /sessions pour les autres.")
    }
    newChat()
    note("Sortie de /cg. /sessions pour retrouver vos discussions.")
  }

  /** Ouvre (ou rouvre) la discussion /cg avec les réglages du menu. */
  function startCg() {
    if (busy()) return flash(t("Une réponse est en cours (échap pour interrompre)."))
    if (cgOn()) {
      refreshZones()
      return note(`Réglages /cg appliqués : ${cgSummary()}`)
    }
    beforeCg = conv
    newChat()
    for (const k of Object.keys(cgSessions)) delete cgSessions[k as CgAgent]
    const miss = (["claude", "codex"] as CgAgent[]).filter((a) => !detected().find((x) => x.id === a)?.installed)
    batch(() => {
      for (const a of ["claude", "codex"] as CgAgent[]) setZones(a, emptyZone(zoneLabel(a)))
      for (const a of miss) setZones(a, "status", "absent")
      setCgPhase("")
      setCgTab("ensemble")
      setCgOn(true)
    })
    conv = mem.newConversation(district(), "[cg] Claude Code et Codex")
    setTitle("Claude Code et Codex")
    if (miss.length === 2) return note(`/cg : ni Claude Code ni Codex n'est installé.\n  Claude Code : ${detected().find((x) => x.id === "claude")?.install}\n  Codex : ${detected().find((x) => x.id === "codex")?.install}`, "error")
    for (const a of miss) note(`${CG_LABEL[a]} n'est pas installé : /cg fonctionnera avec l'autre agent seul, sans relecture croisée.\n  Pour l'installer : ${detected().find((x) => x.id === a)?.install}`, "warn")
    note(`Discussion /cg ouverte : ${cgSummary()}\n/cg pour le menu des réglages · /cg sous-agents · /cg off`)
  }
  const cgSummary = () => {
    const l = prefs().cgLead ?? "codex"
    const o = l === "claude" ? "codex" : "claude"
    const m = prefs().cgMode ?? "auto"
    return `${CG_LABEL[l]} coordonne, ${m === "seul" ? "fait le travail lui-même" : m === "delegue" ? `délègue à ${CG_LABEL[o]}` : "choisit qui écrit"}` +
           `${prefs().cgReview !== false ? ", l'autre relit" : ", sans relecture"}${prefs().cgSubagents !== false ? ", sous-agents autorisés" : ", sans sous-agents"}.`
  }

  async function askCg(text: string) {
    const cfgs: Partial<Record<CgAgent, any>> = {}
    for (const a of ["claude", "codex"] as CgAgent[]) {
      const d = detected().find((x) => x.id === a)
      const s = prefs().agents?.[a] ?? {}
      let power: Power = s.power ?? (a === "codex" ? "commandes" : "modifications")
      if (perms.mode === "lecture" || mode() === "plan") power = "lecture"
      else if (perms.mode.startsWith("bypass") && perms.bypassVerified) power = "bypass"
      if (d?.installed) cfgs[a] = { binary: d.path!, model: s.model, effort: s.effort, power }
    }
    if (!cfgs.claude && !cfgs.codex) return note("/cg : ni Claude Code ni Codex n'est installé.", "error")
    setBusy(true)
    abort = new AbortController()
    batch(() => {
      for (const a of ["claude", "codex"] as CgAgent[]) setZones(a, { status: cfgs[a] ? "en attente" : "absent", entries: [], input: 0, output: 0, label: zoneLabel(a), subs: [] })
    })
    // instantanés seulement si un agent peut écrire ; avertissement donné une seule fois par dossier
    const canWrite = Object.values(cfgs).some((x: any) => x.power !== "lecture")
    const snaps = new Snapshots(cwd())
    const sup = canWrite ? await snaps.unsupported() : "lecture seule"
    if (canWrite && sup && !warnedSnap.has(cwd())) {
      warnedSnap.add(cwd())
      note(`Instantanés indisponibles (${sup}) : /undo ne pourra pas annuler ce que feront les agents. Ouvrez plutôt un projet : /projet NOM.`, "warn")
    }
    const t0 = Date.now()
    const memCtx = mem.context(district(), text)
    const r = await cgTurn({
      text, cwd: cwd(), agents: cfgs, lead: prefs().cgLead ?? "codex", sessions: cgSessions, memory: memCtx.text, sandbox: sandboxOn(), signal: abort.signal,
      mode: prefs().cgMode ?? "auto", review: prefs().cgReview !== false, subagents: prefs().cgSubagents !== false,
      snapshot: sup ? undefined : (l) => snaps.snapshot(l), diff: sup ? undefined : (a, b) => snaps.diff(a, b),
    }, {
      phase: (ph) => { setCgPhase(ph); setActivity(ph) },
      status: (a, s) => setZones(a, "status", s),
      event: (a, e) => {
        if (e.type === "text") {
          // le plan du coordinateur s'affiche en clair, pas en JSON
          const pl = !e.parent && zones[a].status === "coordonne" ? parsePlan(e.text, ["claude", "codex"], a) : null
          const shown = pl ? (pl.simple ? "Réponse directe (demande simple)." : `Plan : ${CG_LABEL[pl.writer]} écrit — ${pl.task}${pl.review ? `\nÀ vérifier : ${pl.review}` : ""}`) : e.text
          zonePush(a, e.parent, { kind: "text", text: shown })
        } else if (e.type === "thinking") zonePush(a, e.parent, { kind: "thinking", text: e.text })
        else if (e.type === "tool") {
          if (!e.done) zonePush(a, e.parent, { kind: "tool", text: `${e.name} ${e.summary}`, running: true })
          else zoneToolDone(a, e.parent, `${e.name} ${e.summary}`, e.ok)
        } else if (e.type === "subagent") {
          // un sous-agent : un point de couleur dans la zone de son agent
          setZones(a, produce((z) => {
            const s = z.subs.find((x) => x.id === e.id)
            if (!s && !e.done) z.subs.push({ id: e.id, label: e.label, color: SUB_COLORS[z.subs.length % SUB_COLORS.length], status: "travaille", entries: [] })
            else if (s && e.done) {
              s.status = e.ok === false ? "échec" : "terminé"
              if (e.output) s.report = e.output
            }
          }))
        } else if (e.type === "usage") {
          setZones(a, "input", (x) => x + e.input)
          setZones(a, "output", (x) => x + e.output)
        } else if (e.type === "error") zonePush(a, undefined, { kind: "error", text: e.message })
      },
    })
    abort = null
    for (const a of ["claude", "codex"] as CgAgent[]) {
      const u = r.usage[a]
      if (u) recordUsage({ session: sessionKey(), model: `cli:${a}`, tokensIn: u.input, tokensOut: u.output, measured: true, usd: null, note: `/cg${u.costUsd != null ? ` · équivalent API ${u.costUsd.toFixed(4)} $` : ""}` })
    }
    const s = (Date.now() - t0) / 1000
    const idx = items.length
    setItems(idx, { role: "assistant", text: r.markdown })
    const tot = (["claude", "codex"] as CgAgent[]).map((a) => r.usage[a] ? `${CG_LABEL[a]} ↓${r.usage[a]!.input} ↑${r.usage[a]!.output}` : "").filter(Boolean).join(" · ")
    setItems(items.length, { role: "notice", level: "info", text: `/cg · ${s.toFixed(1)} s · ${r.plan?.simple ? "réponse directe" : r.plan ? `écrit : ${CG_LABEL[r.plan.writer]} · ${r.rounds} relecture(s) · ${r.verdict}` : "sans plan"} · ${tot}` +
      (r.interrupted ? ` · ${t("interrompu")}` : "") + (r.wrote ? " · fichiers modifiés : /undo pour annuler" : "") })
    setBusy(false)
    if (r.interrupted || !r.markdown) return
    history.push({ role: "user", content: text }, { role: "assistant", content: r.markdown })
    const aid = mem.append(ensureConv(text), "assistant", r.markdown, { cg: true, verdict: r.verdict, writer: r.plan?.writer })
    setItems(idx, "archiveId", aid)
  }

  async function ask(text: string, opts: { aside?: boolean; readOnly?: boolean } = {}) {
    if (cgOn() && !opts.aside) return askCg(text)
    const c = current()
    if (!c) {
      note(t("Aucun modèle choisi : /models"), "warn")
      return openModels()
    }
    if (c.kind === "agent") return askAgent(c.provider, text, opts)
    const p = provider(c.provider)!
    const mi = modelInfo(c)
    const blocked = budget.blocked(c.model!)
    if (blocked) return note(`Envoi bloqué : ${blocked}. /usage pour le détail, /define-token ou /limit pour changer.`, "error")
    const memCtx = mem.context(district(), text)
    const extra: Record<string, unknown> = { ...(prefs().options?.[effortKey(c)] ?? {}) }
    const lv = prefs().effort?.[effortKey(c)]
    const ev = lv ? levelValue(mi?.effort, lv) : undefined
    if (ev && mi?.effortParam) extra[mi.effortParam] = ev
    const useTools = (mi ? mi.tools !== false : c.provider !== "poe") && !noTools.has(effortKey(c)) // bot Poe hors catalogue : sans outils
    const instr = instructions()
    const sys = systemPrompt(mode(), getLang(), cwd(), useTools, perms.mode) + (instr ? "\n\n" + instr : "") + (memCtx.text ? "\n\n" + memCtx.text : "")
    const uc = buildUserContent(text, mi)
    for (const n of uc.notes) note(n, n.includes("non envoyée") || n.includes("introuvable") || n.includes("trop gros") ? "warn" : "info")
    const msgs: Msg[] = [{ role: "system", content: sys }, ...history, { role: "user", content: uc.content as any }]
    if (!useTools && mi?.tools === false) note(`${c.model} n'accepte pas les outils : il répond sans pouvoir lire ni modifier les fichiers.`, "warn")

    setBusy(true)
    abort = new AbortController()
    const signal = abort.signal
    const helpers = prefs().fusionOn !== false ? (prefs().fusion ?? []).map((id) => ({ id, label: id })) : []
    const env: ToolEnv = { roots: [cwd(), ...extraDirs()], perms, memory: mem, districtId: district(), todos: todoList, onTodos: syncTodos, signal, sandbox: sandboxOn(),
                           skills, mcp, helpers, helper: consultHelper }
    const saved = perms.mode
    if (opts.readOnly || mode() === "plan") perms.mode = "lecture"
    const snaps = useTools && !opts.aside && !(opts.readOnly || mode() === "plan" || perms.mode === "lecture") ? new Snapshots(cwd()) : null
    const before = snaps ? await snaps.snapshot(`avant : ${text.slice(0, 60)}`) : null
    let touched = false
    let finalText = ""
    let tin = 0
    let tout = 0
    let measured = false
    const t0 = Date.now()
    const memLine = memCtx.used.length ? `${I.memory} ${t("Mémoire")} : ${memCtx.used.length} ${t("éléments utilisés")}` : undefined
    try {
      for (let step = 0; step < 40 && !signal.aborted; step++) {
        const idx = items.length
        setItems(idx, { role: "assistant", text: "", streaming: true, aside: opts.aside, memory: step === 0 ? memLine : undefined })
        let calls: { id: string; name: string; args: string }[] = []
        let failed = false
        setActivity(`${c.model} réfléchit`)
        const mediaOnly = !!mi?.output && !mi.output.includes("text") // image, vidéo, son : réponse complète, sans flux ni outils
        for await (const e of streamChat(p, c.model!, msgs, { signal, extra, tools: useTools && !mediaOnly ? openAiTools(env) : undefined, noStream: mediaOnly })) {
          if (e.type === "text") setActivity(`${c.model} écrit`)
          if (e.type === "text") setItems(idx, "text", (x) => x + e.text)
          else if (e.type === "thinking") setItems(idx, "thinking", (x) => (x ?? "") + e.text)
          else if (e.type === "usage") {
            measured = true
            tin += e.input ?? 0
            tout += e.output ?? 0
          } else if (e.type === "tools") calls = useTools && !mediaOnly ? e.calls : [] // outils non proposés : aucun appel n'est exécuté
          else if (e.type === "error") {
            failed = true
            if (useTools && /HTTP 400/.test(e.message) && /tool/i.test(e.message) && step === 0) {
              noTools.add(effortKey(c)) // modèle sans outils : on repart sans
              setItems((xs) => xs.slice(0, idx))
              perms.mode = saved
              setBusy(false)
              abort = null
              note(`${c.model} refuse les outils : nouvelle tentative sans outils.`, "warn")
              return ask(text, opts)
            }
            setItems(idx, produce((it) => { it.level = "error"; it.text = (it.text ? it.text + "\n\n" : "") + e.message }))
            if (/HTTP 40[13]/.test(e.message)) {
              setStatus(c.provider, { key: "invalid", keyNote: `${p.label} refuse la clé : supprimée ou modifiée`, models: status[c.provider]?.models })
              needKey(c.provider, true)
            }
          }
        }
        setItems(idx, "streaming", false)
        const stepText = items[idx].text
        if (!stepText && !items[idx].thinking && !failed) setItems((xs) => xs.filter((_, i) => i !== idx)) // étape sans texte : rien à montrer
        if (stepText && !failed) finalText += (finalText ? "\n\n" : "") + stepText
        if (failed || !calls.length) break
        msgs.push({ role: "assistant", content: stepText || null, tool_calls: calls.map((x) => ({ id: x.id, type: "function", function: { name: x.name, arguments: x.args } })) })
        for (const call of calls) {
          if (signal.aborted) break
          let args: any = {}
          try {
            args = JSON.parse(call.args || "{}")
          } catch {}
          const ti = items.length
          setActivity(`outil ${call.name} · ${summarize(call.name, args).slice(0, 50)}`)
          setItems(ti, { role: "tool", text: summarize(call.name, args), tool: call.name, running: true })
          const r = await runTool(env, call)
          if (!READ_ONLY_TOOLS.has(call.name) && r.ok) touched = true
          setItems(ti, produce((it) => { it.running = false; it.ok = r.ok; it.output = r.output; it.diff = r.diff }))
          msgs.push({ role: "tool", tool_call_id: call.id, content: r.output.slice(0, 30_000) })
        }
      }
    } finally {
      perms.mode = saved
    }
    const interrupted = signal.aborted
    abort = null
    const s = (Date.now() - t0) / 1000
    if (!measured) {
      tin = estimateTokens(msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n"))
      tout = estimateTokens(finalText)
    }
    if (tin || tout) recordUsage({ session: sessionKey(), model: c.model!, tokensIn: tin, tokensOut: tout, measured, usd: estimateUsd(mi?.priceIn, mi?.priceOut, tin, tout), rate: rate(),
                                     note: `${c.provider}${opts.aside ? " · /btw" : ""}` })
    const u = usage[effortKey(c)] ?? { in: 0, out: 0, turns: 0 }
    batch(() => {
      setUsage(effortKey(c), { in: u.in + tin, out: u.out + tout, turns: u.turns + 1 })
      setItems(items.length, { role: "notice", text: `${mode() === "plan" || opts.readOnly ? "Plan" : "Build"} · ${c.model} · ${s.toFixed(1)} s` +
        (tout ? ` · ${Math.round(tout / Math.max(s, 0.1))} tok/s` : "") + ` · ↓${tin} ↑${tout} tok${measured ? "" : " (estimés)"}` +
        (interrupted ? ` · ${t("interrompu")}` : "") + (opts.aside ? " · à part, non gardé" : "") + (touched ? " · fichiers modifiés : /undo pour annuler" : ""), level: "info" })
      setBusy(false)
    })
    if (snaps && before) {
      const after = await snaps.snapshot(`après : ${text.slice(0, 60)}`)
      touched = !!after && (await snaps.changed(before, after))
    }
    if (touched && before) {
      undoStack.push({ before, label: text.slice(0, 60) })
      redoStack.length = 0
    }
    if (opts.aside || !finalText) return
    history.push({ role: "user", content: text }, { role: "assistant", content: finalText })
    const aid = mem.append(ensureConv(text), "assistant", finalText, { provider: c.provider, model: c.model, interrupted })
    for (let i = items.length - 1; i >= 0; i--) if (items[i].role === "assistant") { setItems(i, "archiveId", aid); break }
    // objectif en cours : on continue tant qu'il n'est pas atteint (20 tours au plus)
    const g = goal()
    if (g?.active && !interrupted) {
      if (/OBJECTIF ATTEINT/i.test(finalText)) {
        setGoal({ ...g, active: false })
        note(`${I.ok} Objectif atteint en ${g.rounds + 1} tour(s) : ${g.text}`)
      } else if (g.rounds + 1 >= 20) {
        setGoal({ ...g, active: false })
        note(`Objectif mis en pause après 20 tours : /goal resume pour continuer.`, "warn")
      } else {
        setGoal({ ...g, rounds: g.rounds + 1 })
        setTimeout(() => send(`Continue vers l'objectif : ${g.text}\nQuand il est entièrement atteint et vérifié, termine ta réponse par la ligne « OBJECTIF ATTEINT ».`), 300)
      }
    }
  }

  /** Ouvre (ou crée) un projet et y place la discussion. */
  function enterProject(name: string): boolean {
    try {
      const p = openProject(name)
      setCwd(p)
      setDistrict(mem.district(p))
      loadExtensions()
      note(`Projet : ${short(p)} — les modèles et les agents travaillent dans ce dossier.`)
      return true
    } catch (e) {
      note((e as Error).message, "error")
      return false
    }
  }

  /** Travail qui peut écrire alors qu'on est dans Eclipse, le dossier personnel ou ~/Projets : choisir le projet d'abord. */
  function chooseProjectThen(text: string, then: () => void) {
    const proposed = slug(text)
    const existing = listProjects()
    openList(`Dans quel projet ? (dossiers de ${short(projectsRoot())})`, () => [
      { title: `Nouveau : ${proposed}`, detail: "crée le dossier et y travaille", value: `new:${proposed}` },
      { title: "Nouveau, autre nom…", value: "ask" },
      ...(existing.length ? [{ title: "REPRENDRE UN PROJET", header: true } as ListEntry] : []),
      ...existing.slice(0, 40).map((x) => ({ title: x.name, detail: new Date(x.mtime).toLocaleDateString("fr-FR"), right: short(x.path), value: `old:${x.name}` })),
    ], (v) => {
      closeOverlay()
      if (v === "ask") return later({ type: "text", title: "Nom du nouveau projet", initial: proposed, onSubmit: (n) => n && enterProject(n) && then() })
      if (enterProject(v.slice(4))) then()
    }, "entrée : ouvrir · échap : annuler (rien n'est envoyé)")
  }

  async function send(text: string) {
    const writes = !(mode() === "plan" || perms.mode === "lecture")
    if (writes && needsProject(cwd())) {
      prompt?.setText(text)
      setDraft(text)
      return chooseProjectThen(text, () => { prompt?.clear(); setDraft(""); send(text) })
    }
    const idx = items.length
    setItems(idx, { role: "user", text })
    const id = mem.append(ensureConv(text), "user", text)
    setItems(idx, "archiveId", id)
    const fact = rememberRequest(text)
    if (fact) {
      const r = mem.addItem(district(), "fact", fact, { sourceArchiveId: id })
      note(`${I.memory} ${t("Mémorisé")} : « ${fact} »${r.duplicate ? " (déjà connu)" : ""} · /memory pour voir ou oublier`, "info")
    }
    await ask(text)
  }

  /** Retire le dernier échange (archive conservée, marquée annulée comme dans la version Python) ; renvoie le texte demandé. */
  function dropLastExchange(): string | null {
    let u = -1
    for (let i = items.length - 1; i >= 0; i--) if (items[i].role === "user") { u = i; break }
    if (u < 0) return null
    const text = items[u].text
    const ids = items.slice(u).map((x) => x.archiveId).filter((x): x is number => !!x)
    if (conv && ids.length) mem.db.query("INSERT INTO undone(conversation_id,from_id,to_id,active,ts) VALUES(?,?,?,1,?)").run(conv, Math.min(...ids), Math.max(...ids), Date.now() / 1000)
    setItems((xs) => xs.slice(0, u))
    if (history.length >= 2 && history[history.length - 2].role === "user") history = history.slice(0, -2)
    return text
  }

  // ------------------------------------------------------------ commandes
  const lastAnswer = () => [...items].reverse().find((x) => x.role === "assistant" && !x.aside && x.text)?.text

  async function runCommand(raw: string) {
    const body = raw.slice(1).trim()
    const [name, ...rest] = body.split(/\s+/)
    let arg = rest.join(" ").trim()
    const c = resolve(name)
    // dans /cg, « /model codex NOM », « /effort claude high », « /power codex lecture » visent un agent précis
    let cgTarget: Choice | null = null
    if (cgOn() && c && ["model", "effort", "power"].includes(c.name)) {
      const m = arg.match(/^(claude|codex)\b\s*(.*)$/)
      if (m) {
        cgTarget = { kind: "agent", provider: m[1] }
        arg = m[2]
      } else if (!arg) return note(`Dans /cg, précisez l'agent : /${c.name} claude … ou /${c.name} codex …`, "warn")
    }
    if (!c) {
      const pc = pluginCmds.find((x) => x.name === name)
      if (pc) {
        try {
          const out = await pc.run(arg)
          return note(`[plugin ${pc.plugin}] ${String(out ?? "")}`)
        } catch (e) {
          return note(`Erreur du plugin ${pc.plugin} : ${(e as Error).message}`, "error")
        }
      }
      return note(`${t("Commande inconnue")} : /${name}  (/help)`, "error")
    }
    if (!c.ready) return note(`/${c.name} : pas encore disponible dans cette version (étape « ${c.step} » du plan). La liste complète : /help.`, "warn")
    switch (c.name) {
      case "connect": {
        const cur = current()
        const s = cur?.kind === "api" ? status[cur.provider] : undefined
        if (cur?.kind === "api" && s && s.key !== "ok" && s.key !== "local") return needKey(cur.provider, true)
        if (arg && provider(arg)) return later({ type: "key", id: arg })
        return openModels()
      }
      case "disconnect": {
        const p = provider(arg)
        if (!p || p.local) return note("Usage : /disconnect ID  (ex. poe, openrouter). Les clés en variable d'environnement ne sont pas touchées.", "error")
        const r = await secretRun(["secret-tool", "clear", "service", SERVICE, "username", p.id])
        note(r.code === 0 ? `Clé de ${p.label} retirée du trousseau.` : `Retrait impossible : ${r.err.trim() || "code " + r.code}`, r.code === 0 ? "info" : "error")
        return loadProvider(p.id, true)
      }
      case "provider":
        return openModels(arg && provider(arg) ? arg : undefined)
      case "models":
        return openModels()
      case "cg": {
        if (arg === "off") return leaveCg()
        const [sub, who] = arg.split(/\s+/)
        if (sub === "lead" && (who === "claude" || who === "codex")) {
          updatePrefs({ cgLead: who })
          return flash(`Coordinateur /cg : ${CG_LABEL[who as CgAgent]}`)
        }
        if (sub === "sous-agents" || sub === "agents") {
          const all = (["claude", "codex"] as CgAgent[]).flatMap((a) => zones[a].subs.map((s) => ({ a, s })))
          if (!all.length) return note("Aucun sous-agent pour l'instant.", "warn")
          return openList("Sous-agents", () => all.map(({ a, s }) => ({ title: `${s.status === "travaille" ? "●" : s.status === "échec" ? "×" : "○"} ${s.label}`, detail: s.status, right: CG_LABEL[a], value: `${a}\n${s.id}` })),
                          (v) => { const [ag, id] = v.split("\n"); later({ type: "sub", agent: ag as CgAgent, id }) })
        }
        if (sub === "go" || sub === "start") return startCg()
        // sans argument : le menu (coordinateur, façon de travailler, modèles, efforts, puissances, sous-agents)
        Promise.all((["claude", "codex"] as CgAgent[]).map(async (a) => {
          const d = detected().find((x) => x.id === a)
          return [a, d?.installed ? await agentModels(a, d.path!) : []] as const
        })).then((r) => setCgModels(Object.fromEntries(r)))
        return later({ type: "cgmenu" })
      }
      case "power": {
        const cur = cgTarget ?? current()
        if (cur?.kind !== "agent") return note("/power règle un agent (Claude Code, Codex…). Pour les modèles d'API : /permissions.", "warn")
        const setP = (v: string) => {
          const ags = { ...(prefs().agents ?? {}) }
          ags[cur.provider] = { ...(ags[cur.provider] ?? {}), power: v as any }
          updatePrefs({ agents: ags })
          closeOverlay()
          flash(`Puissance de ${agentName(cur.provider)} → ${v}`)
        }
        if (["lecture", "modifications", "commandes"].includes(arg)) return setP(arg)
        return openList(`Puissance — ${agentName(cur.provider)}`, () => (["lecture", "modifications", "commandes"] as Power[]).map((p) => ({ title: p, detail: POWER_LABEL[p], value: p })), setP)
      }
      case "model": {
        const curA = cgTarget ?? current()
        if (curA?.kind === "agent") {
          const d = detected().find((x) => x.id === curA.provider)
          const setM = (v: string) => {
            const ags = { ...(prefs().agents ?? {}) }
            ags[curA.provider] = { ...(ags[curA.provider] ?? {}), model: v === "défaut" ? undefined : v }
            updatePrefs({ agents: ags })
            closeOverlay()
            flash(`Modèle de ${agentName(curA.provider)} → ${v}`)
          }
          if (arg) return setM(arg)
          flash("Lecture des modèles de l'agent…")
          const ms = d?.path ? await agentModels(curA.provider, d.path) : []
          if (!ms.length) return later({ type: "text", title: `Modèle de ${agentName(curA.provider)} (format propre à l'agent)`, initial: prefs().agents?.[curA.provider]?.model ?? "", onSubmit: (v) => setM(v || "défaut") })
          return openList(`Modèles — ${agentName(curA.provider)}`, () => [{ title: "défaut de l'agent", value: "défaut" }, ...ms.map((m) => ({ title: m.id, detail: m.efforts.length ? "effort " + m.efforts.join("/") : "", value: m.id }))], setM)
        }
        if (!arg) return openModels()
        const cur = current()
        const order = [...(cur?.kind === "api" ? [cur.provider] : []), ...PROVIDERS.map((p) => p.id)]
        for (const pid of order) if (status[pid]?.models?.some((m) => m.id === arg)) return pick({ kind: "api", provider: pid, model: arg })
        return note(`Modèle introuvable dans les catalogues chargés : ${arg}. Cherchez-le avec /models.`, "error")
      }
      case "effort": {
        const cur = cgTarget ?? current()
        if (cur?.kind === "agent") {
          const d = detected().find((x) => x.id === cur.provider)
          const ms = d?.path ? await agentModels(cur.provider, d.path) : []
          const a0 = prefs().agents?.[cur.provider] ?? {}
          const choices = ms.find((m) => m.id === a0.model)?.efforts ?? ms[0]?.efforts ?? []
          const setE = (v: string) => {
            const ags = { ...(prefs().agents ?? {}) }
            const map: Record<string, string> = { rapide: "low", normal: "medium", profond: "high" }
            ags[cur.provider] = { ...a0, effort: v === "défaut" ? undefined : map[v] ?? v }
            updatePrefs({ agents: ags })
            closeOverlay()
            flash(`Effort de ${agentName(cur.provider)} → ${ags[cur.provider].effort ?? "défaut"}`)
          }
          if (arg) return setE(arg)
          if (!choices.length) return note(`${agentName(cur.provider)} : réglage d'effort non disponible depuis Eclipse.`, "warn")
          return openList(`Effort — ${agentName(cur.provider)}`, () => [{ title: "défaut de l'agent", value: "défaut" }, ...LEVELS.map((l) => ({ title: l, detail: `→ ${{ rapide: "low", normal: "medium", profond: "high" }[l]}`, value: l })), ...choices.map((x) => ({ title: x, detail: "valeur exacte", value: x }))], setE)
        }
        const mi = modelInfo(cur)
        if (!mi?.effort?.length) return note(`${cur?.model ?? "Ce modèle"} n'annonce pas de réglage d'effort.`, "warn")
        const apply = (v: string) => {
          const eff = { ...(prefs().effort ?? {}) }
          if (v === "défaut") delete eff[effortKey(cur)]
          else eff[effortKey(cur)] = v
          updatePrefs({ effort: eff })
          closeOverlay()
          flash(`Effort → ${v}${v !== "défaut" && LEVELS.includes(v as any) ? ` (${levelValue(mi.effort, v)})` : ""}`)
        }
        if (arg) return arg === "défaut" || LEVELS.includes(arg as any) || mi.effort.includes(arg) ? apply(arg) : note(`Effort : rapide, normal, profond, défaut, ou ${mi.effort.join(", ")}`, "error")
        return openList(`Effort — ${mi.id}`, () => [
          { title: "défaut du modèle", value: "défaut" },
          ...LEVELS.map((l) => ({ title: l, detail: `→ ${levelValue(mi.effort, l)}`, value: l })),
          ...mi.effort!.map((e) => ({ title: e, detail: "valeur exacte", value: e })),
        ], apply)
      }
      case "free": {
        const free: ListEntry[] = []
        for (const p of PROVIDERS) for (const m of status[p.id]?.models ?? []) if (m.free) free.push({ title: m.id, detail: p.label, value: `${p.id}\n${m.id}` })
        if (!free.length) return note("Aucun modèle gratuit dans les catalogues chargés (les fournisseurs sans clé ne sont pas interrogés ; LM Studio ou Ollama sont gratuits en local).", "warn")
        return openList("Modèles gratuits", () => free, (v) => { const [pid, mid] = v.split("\n"); pick({ kind: "api", provider: pid, model: mid }) })
      }
      case "detect": {
        flash("Détection des agents…")
        const d = await refreshAll(true)
        return note(d.map((x) => (x.installed ? `${I.ok} ${x.label.padEnd(20)} ${short(x.path!)}  ${x.version ?? x.versionError ?? ""}  (${x.source})` : `${I.off} ${x.label.padEnd(20)} ${t("non installé")} — ${x.install}`)).join("\n"))
      }
      case "agent-path": {
        const [aid, ...pp] = arg.split(/\s+/)
        if (!aid || !detected().some((d) => d.id === aid)) return note("Usage : /agent-path ID [CHEMIN]  (ID : " + detected().map((d) => d.id).join(", ") + ")", "error")
        const path = pp.join(" ").replace(/^~/, home())
        const ap = { ...st().agentPaths }
        if (!path) delete ap[aid]
        else if (!existsSync(path)) return note(`Fichier introuvable : ${path}`, "error")
        else ap[aid] = path
        const next = { ...st(), agentPaths: ap }
        setSt(next)
        save(next)
        await refreshAll()
        return note(path ? `Chemin de ${aid} : ${path}` : `${aid} : retour à la détection automatique`)
      }
      case "new":
        if (cgOn()) return leaveCg()
        newChat()
        return flash("Nouvelle discussion")
      case "sessions":
      case "open": {
        const all = c.name === "open"
        const list = mem.conversations(all ? undefined : district(), 400).filter((x) => cgOn() === (x.title ?? "").startsWith("[cg]")).slice(0, 200)
        if (!list.length) return note("Aucune session enregistrée pour ce projet. /open pour tous les projets.", "warn")
        return openList(all ? "Sessions et projets" : t("Sessions"), () => list.map((x) => ({
          title: x.title || `Session ${x.id}`, detail: `${x.count} échanges` + (all ? ` · ${x.district}` : ""),
          right: new Date(x.last * 1000).toLocaleString(getLang() === "fr" ? "fr-FR" : "en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
          value: String(x.id),
        })), (v) => { closeOverlay(); loadConversation(Number(v)) })
      }
      case "voice": {
        if (arg === "installer" || arg === "install") {
          setBusy(true)
          const r = await V.install((step) => setActivity(`installation de la voix : ${step}`))
          setBusy(false)
          return note(r.ok ? r.message + " Tapez /voice pour appeler." : `Installation de la voix impossible : ${r.message}`, r.ok ? "info" : "error")
        }
        if (arg === "précis" || arg === "precis" || arg === "rapide") {
          updatePrefs({ voiceModel: arg === "rapide" ? "base" : "small" })
          return note(arg === "rapide" ? "Transcription rapide (modèle base, environ 3 s par phrase)." : "Transcription précise (modèle small, environ 10 s par phrase sur ce PC).")
        }
        if (arg === "état" || arg === "etat" || arg === "status") {
          const s = V.setup(prefs().voiceModel)
          return note(`Voix : transcription ${s.whisper && s.model ? "whisper.cpp (" + s.model.split("/").pop() + ")" : "absente"} · voix ${s.piper && s.voice ? "piper (fr_FR-siwis)" : s.espeak ? "espeak-ng (robotique)" : "absente"} · micro ${s.record ? "arecord" : "absent"}` +
                      (s.missing.length ? "\nManque : " + s.missing.join(" ; ") : ""))
        }
        return voiceOn() ? hangUp() : startVoice()
      }
      case "projet": {
        if (arg) return enterProject(arg)
        return chooseProjectThen("", () => {})
      }
      case "cd": {
        const target = resolvePath(cwd(), (arg || "~").replace(/^~/, home()))
        if (!existsSync(target) || !statSync(target).isDirectory()) return note(`Dossier introuvable : ${target}`, "error")
        setCwd(target)
        setDistrict(mem.district(target))
        newChat()
        loadExtensions()
        return flash(`Dossier : ${short(target)}`)
      }
      case "rename":
        if (!conv) return note("Rien à renommer : la discussion n'a pas encore commencé.", "warn")
        if (!arg) return note("Usage : /rename TITRE", "error")
        mem.setTitle(conv, arg)
        setTitle(arg)
        return flash("Session renommée")
      case "fork": {
        if (!conv) return note("Rien à dupliquer : la discussion n'a pas encore commencé.", "warn")
        const n = mem.fork(conv, `${title()} (copie)`)
        loadConversation(n)
        return flash("Copie créée : la suite n'affecte pas l'originale")
      }
      case "retry": {
        if (busy()) return flash(t("Une réponse est en cours (échap pour interrompre)."))
        const text = dropLastExchange()
        return text ? send(text) : note("Aucun message à relancer.", "warn")
      }
      case "edit": {
        const text = dropLastExchange()
        if (!text) return note("Aucun message à modifier.", "warn")
        prompt?.setText(text)
        return setDraft(text)
      }
      case "btw":
        if (!arg) return note("Usage : /btw QUESTION — réponse ponctuelle, non gardée dans la discussion", "error")
        setItems(items.length, { role: "user", text: arg, aside: true })
        return ask(arg, { aside: true })
      case "export": {
        if (!items.length) return note("Rien à exporter.", "warn")
        const dir = join(dataDir(), "exports")
        mkdirSync(dir, { recursive: true })
        const f = join(dir, `${(title() || "discussion").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`)
        writeFileSync(f, `# ${title() || "Discussion"}\n\n` + items.filter((x) => x.role !== "notice").map((x) => (x.role === "user" ? `## Vous\n\n${x.text}` : `## Modèle\n\n${x.text}`)).join("\n\n") + "\n")
        return note(`Exporté : ${short(f)}`)
      }
      case "copy": {
        const a = lastAnswer()
        if (!a) return note("Aucune réponse à copier.", "warn")
        return flash(renderer.copyToClipboardOSC52(a) ? "Réponse copiée (presse-papiers du terminal)" : "Copie refusée par le terminal (OSC 52)")
      }
      case "agents":
      case "mode": {
        const setMode = (m: string) => {
          updatePrefs({ mode: m as "build" | "plan" })
          closeOverlay()
          flash(`Mode → ${m}`)
        }
        if (arg === "build" || arg === "plan") return setMode(arg)
        return openList("Modes", () => [
          { title: "build", detail: "travail normal", value: "build" },
          { title: "plan", detail: "analyse et plan, sans modifications", value: "plan" },
        ], setMode)
      }
      case "usage":
        return later({ type: "usage" })
      case "reload":
        setSt(load())
        await loadExtensions()
        await refreshAll(true)
        return flash("Rechargé : réglages, clés, catalogues, agents")
      case "themes": {
        const apply = (v: string) => {
          if (v.startsWith("icons:")) {
            setIcons(v.slice(6) as "nerd" | "texte")
            updatePrefs({ icons: v.slice(6) as "nerd" | "texte" })
          } else {
            setTheme(v as ThemeName)
            updatePrefs({ theme: v as ThemeName })
          }
          closeOverlay()
          setUi((x) => x + 1)
        }
        return openList(t("Thème"), () => [
          { title: "THÈMES", header: true },
          ...(Object.keys(THEME_LABEL) as ThemeName[]).map((k) => ({ title: k, detail: THEME_LABEL[k] + (k === themeName ? "  (actuel)" : ""), value: k })),
          { title: "ICÔNES", header: true },
          { title: "nerd", detail: "icônes Nerd Font" + (iconSet === "nerd" ? "  (actuel)" : ""), value: "icons:nerd" },
          { title: "texte", detail: "icônes en texte simple, pour toute police" + (iconSet === "texte" ? "  (actuel)" : ""), value: "icons:texte" },
        ], apply)
      }
      case "language": {
        const apply = (v: string) => {
          setLang(v as Lang)
          updatePrefs({ lang: v as Lang })
          closeOverlay()
          setUi((x) => x + 1)
        }
        if (arg === "fr" || arg === "en") return apply(arg)
        return openList(t("Langue"), () => [{ title: "Français", value: "fr", detail: getLang() === "fr" ? "(actuelle)" : "" },
                                             { title: "English", value: "en", detail: getLang() === "en" ? "(current)" : "" }], apply)
      }
      case "thinking":
        updatePrefs({ showThinking: !prefs().showThinking })
        return flash(prefs().showThinking ? "Réflexion affichée" : "Réflexion masquée (résumé seulement)")
      case "editor": {
        const f = join(tmpdir(), `eclipse-message-${process.pid}.md`)
        writeFileSync(f, prompt?.plainText ?? "")
        const ed = process.env.VISUAL || process.env.EDITOR || (Bun.which("nano") ? "nano" : "vi")
        await renderer.suspend()
        Bun.spawnSync([ed, f], { stdio: ["inherit", "inherit", "inherit"] })
        await renderer.resume()
        const txt = readFileSync(f, "utf8").replace(/\n+$/, "")
        prompt?.setText(txt)
        setDraft(txt)
        return prompt?.focus()
      }
      case "diff": {
        const s = await runCmd(["git", "-C", cwd(), "diff", "--stat"], { timeoutMs: 10_000 })
        if (s.code !== 0) return note(`Pas de dépôt Git ici, ou git indisponible : ${s.err.trim().split("\n")[0]}`, "warn")
        const d = await runCmd(["git", "-C", cwd(), "diff"], { timeoutMs: 10_000 })
        if (!s.out.trim()) return note("Aucune modification en cours (git diff vide).")
        const lines = d.out.split("\n")
        return setItems(items.length, { role: "assistant", text: "```diff\n" + lines.slice(0, 300).join("\n") + (lines.length > 300 ? `\n… ${lines.length - 300} lignes de plus` : "") + "\n```", meta: s.out.trim().split("\n").pop() })
      }
      case "status": {
        const cur = current()
        const ks = cur?.kind === "api" ? status[cur.provider] : undefined
        return note([
          `Fournisseur : ${cur ? (cur.kind === "agent" ? agentName(cur.provider) + " (agent)" : provider(cur.provider)?.label) : "aucun"}${ks ? ` — ${ks.keyNote}` : ""}`,
          `Modèle      : ${cur?.model ?? "—"}${effortLabel()}`,
          `Mode        : ${mode()} · langue ${getLang()} · thème ${themeName} · icônes ${iconSet}`,
          `Dossier     : ${short(cwd())} · mémoire : ${mem.items(district()).length} éléments`,
          `Agents      : ${detected().filter((d) => d.installed).map((d) => d.label).join(", ") || "aucun"}`,
        ].join("\n"))
      }
      case "doctor": {
        flash("Diagnostic…")
        const poe = provider("poe")!
        const [vk, net] = await Promise.all([verifyKey(poe), fetch("https://api.poe.com/v1/models", { signal: AbortSignal.timeout(8000) }).then((r) => `HTTP ${r.status}`, (e) => (e as Error).name)])
        const d = detected()
        return note([
          `Eclipse ${VERSION} · Bun ${Bun.version} · ${process.platform} · terminal ${process.env.TERM ?? "?"}${process.env.COLORTERM ? " · " + process.env.COLORTERM : ""}${process.env.NO_COLOR ? " · NO_COLOR" : ""}`,
          `Données     : ${short(dataDir())} (mémoire : ${short(join(dataDir(), "memory.db"))})`,
          `Trousseau   : ${storageName()}`,
          `Poe         : réseau ${net} · clé ${vk.check} (${vk.detail})`,
          ...d.map((x) => `${x.installed ? I.ok : I.off} ${x.label.padEnd(20)} ${x.installed ? `${short(x.path!)} · ${x.version ?? x.versionError} · via ${x.source}` : x.reason}`),
        ].join("\n"))
      }
      case "memory": {
        const d = district()
        const [sub, ...r2] = arg.split(/\s+/)
        const rest2 = r2.join(" ")
        if (sub === "add" && rest2) {
          const r = mem.addItem(d, "fact", rest2)
          return note(`${I.memory} ${r.duplicate ? "Déjà connu" : "Ajouté"} (n° ${r.id}) : ${rest2}`)
        }
        if ((sub === "forget" || sub === "oublie") && Number(rest2)) {
          mem.setStatus(Number(rest2), "forgotten")
          return note(`Élément n° ${rest2} oublié (gardé dans l'historique, plus jamais transmis).`)
        }
        if ((sub === "pin" || sub === "unpin") && Number(rest2)) {
          mem.pin(Number(rest2), sub === "pin")
          return note(sub === "pin" ? `Élément n° ${rest2} épinglé : transmis à chaque message.` : `Élément n° ${rest2} désépinglé.`)
        }
        if (arg) {
          const hits: Hit[] = mem.search(arg, { districtId: d, limit: 12 })
          return note(hits.length ? `Mémoire — « ${arg} » :\n` + hits.map((h) => `  [${h.layer}] ${h.text.replace(/\s+/g, " ").slice(0, 160)}  (${h.ref})`).join("\n") : `Rien en mémoire pour « ${arg} ».`)
        }
        const its = mem.items(d)
        const contra = mem.openContradictions(d)
        return note((its.length ? `Mémoire du projet (${its.length}) :\n` + its.slice(0, 40).map((i) => `  ${String(i.id).padStart(4)} ${i.pinned ? "[épinglé] " : ""}[${KIND_LABEL[i.kind] ?? i.kind}] ${i.content.slice(0, 150)}`).join("\n")
                       : "Mémoire du projet vide. Écrivez « retiens que … » ou /memory add TEXTE.") +
                    (contra.length ? `\n\n${I.warn} Contradictions à trancher :\n` + contra.map((x) => `  « ${x.a} » ≠ « ${x.b} »`).join("\n") : "") +
                    "\n\n/memory REQUÊTE · /memory add TEXTE · /memory pin N · /memory forget N")
      }
      case "context": {
        const cur = draft() || "(message vide)"
        const mc = mem.context(district(), cur)
        const sys = systemPrompt(mode(), getLang(), cwd())
        const hist = history.reduce((n, m) => n + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")), 0)
        return note([
          "Envoyé au modèle avec le prochain message (estimation, 4 caractères ≈ 1 token) :",
          `  consignes d'Eclipse   ≈ ${estimateTokens(sys)} tok`,
          `  mémoire du projet     ≈ ${estimateTokens(mc.text)} tok (${mc.used.length} éléments)`,
          `  historique            ≈ ${hist} tok (${history.length} messages)`,
        ].join("\n"))
      }
      case "rate": {
        const n = Number(arg.replace(",", "."))
        if (!arg || !Number.isFinite(n) || n <= 0) return note(`Usage : /rate N — nombre de points Poe par dollar (sert à estimer les points). Actuel : ${rate() ?? "non saisi"}`, rate() ? "info" : "warn")
        updatePrefs({ rate: n })
        return flash(`Taux : ${n} points par dollar (saisi)`)
      }
      case "spent": {
        const n = Number(arg.replace(",", "."))
        if (!arg || !Number.isFinite(n) || n <= 0) return note("Usage : /spent N — dépense en points saisie à la main (comptée « saisi » dans /usage)", "error")
        budget.addManual(sessionKey(), n)
        return flash(`${n} points enregistrés (saisie manuelle)`)
      }
      case "limit": {
        if (arg === "off") {
          budget.clearEnvelope("limit")
          return flash("Limite retirée")
        }
        const [nRaw, per] = arg.split(/\s+/)
        const n = Number((nRaw ?? "").replace(/[\s_]/g, ""))
        const ps = per ? parseDuration(per) : 0
        if (!nRaw || !Number.isInteger(n) || n <= 0 || (per && ps == null)) return note("Usage : /limit N [5h|30m|1d|1w] — limite de tokens (bloque à 100 %) · /limit off", "error")
        const scope = current()?.model ?? (current()?.kind === "agent" ? `cli:${current()!.provider}` : "*")
        budget.setEnvelope({ kind: "limit", name: `limite ${scope}`, amountPoints: null, tokenLimit: n, periodS: ps ?? 0, scope: [scope] })
        return flash(`Limite : ${n} tokens${ps ? " par " + per : ""} pour ${scope}`)
      }
      case "define-token": {
        if (arg === "off") {
          budget.clearEnvelope("temporary")
          return flash("Budget retiré")
        }
        // /define-token 500 [pts|tok] [1d] [avertir]
        const m = arg.match(/^(\d+(?:[.,]\d+)?)\s*(pts?|points?|tok|tokens?)?\s*(\d+\s*[mhdw])?\s*(avertir|warn)?$/i)
        if (!m) return note("Usage : /define-token N [pts|tok] [période : 30m, 5h, 1d, 1w] [avertir] · /define-token off\nEx. /define-token 500 pts 1d · /define-token 200000 tok 5h avertir\nPar défaut : points, sans période, et l'envoi est bloqué à 100 % (« avertir » : seulement prévenir).", arg ? "error" : "info")
        const n = Number(m[1].replace(",", "."))
        const isTok = /^tok/i.test(m[2] ?? "")
        const ps = m[3] ? parseDuration(m[3].replace(/\s+/g, "")) ?? 0 : 0
        if (!isTok && !rate()) note("Sans taux points/$ (/rate), les points de chaque réponse sont « indisponibles » : le budget en points ne pourra pas avancer.", "warn")
        budget.setEnvelope({ kind: "temporary", name: "budget", amountPoints: isTok ? null : n, tokenLimit: isTok ? n : null, periodS: ps, onExhaust: m[4] ? "warn" : "pause" })
        return flash(`Budget : ${n} ${isTok ? "tokens" : "points"}${ps ? " par " + m[3] : ""}${m[4] ? " (avertit)" : " (bloque à 100 %)"}`)
      }
      case "options": {
        const cur = current()
        const mi = modelInfo(cur)
        const params = (mi?.params ?? []).filter((x) => x.name !== mi?.effortParam)
        if (!mi || !params.length) return note(`${cur?.model ?? "Ce modèle"} n'annonce aucun autre réglage dans le catalogue${mi?.effort ? " (l'effort : /effort)" : ""}.`, "warn")
        const k = effortKey(cur)
        const setOpt = (name: string, value: unknown) => {
          const all = { ...(prefs().options ?? {}) }
          const o = { ...(all[k] ?? {}) }
          if (value === undefined) delete o[name]
          else o[name] = value
          all[k] = o
          updatePrefs({ options: all })
          closeOverlay()
          flash(`${name} → ${value === undefined ? "défaut" : String(value)}`)
        }
        return openList(`Réglages de ${mi.id}`, () => params.map((x) => {
          const v = prefs().options?.[k]?.[x.name]
          return { title: x.name, detail: `${v === undefined ? "défaut" : String(v)} · ${x.kind}${x.choices ? " " + x.choices.join("/") : ""}${x.description ? " — " + x.description : ""}`, value: x.name }
        }), (name) => {
          const x = params.find((y) => y.name === name)!
          if (x.kind === "enum" || x.kind === "boolean") {
            const vals = x.kind === "enum" ? x.choices! : ["on", "off"]
            return openList(name, () => [{ title: "défaut du modèle", value: "\u0000" }, ...vals.map((v) => ({ title: v, value: v }))],
                            (v) => setOpt(name, v === "\u0000" ? undefined : x.kind === "boolean" ? v === "on" : v))
          }
          later({ type: "text", title: `${name} (${x.kind})`, note: x.description, initial: String(prefs().options?.[k]?.[name] ?? ""), onSubmit: (raw) => {
            if (!raw) return setOpt(name, undefined)
            try {
              setOpt(name, coerce(x, raw))
            } catch (e) {
              flash(`Valeur invalide : ${(e as Error).message}`)
            }
          } })
        })
      }
      case "settings": {
        const entries = (): ListEntry[] => [
          { title: "Thème", detail: `${themeName} · icônes ${iconSet}`, value: "/themes" },
          { title: "Langue", detail: getLang(), value: "/language" },
          { title: "Mode", detail: mode(), value: "/mode" },
          { title: "Réflexion du modèle", detail: prefs().showThinking ? "affichée" : "résumée", value: "/thinking" },
          { title: "Barre latérale", detail: prefs().sidebar ? "affichée" : "masquée", value: "/sidebar" },
          { title: "Modèle", detail: currentLabel(), value: "/models" },
          { title: "Effort", detail: prefs().effort?.[effortKey(current())] ?? "défaut", value: "/effort" },
          { title: "Réglages du modèle", detail: `${Object.keys(prefs().options?.[effortKey(current())] ?? {}).length} modifié(s)`, value: "/options" },
          { title: "Taux points/$", detail: rate() ? String(rate()) : "non saisi", value: "/rate" },
          { title: "Clés d'API", detail: "connexions", value: "/connect" },
          { title: "Chemins des agents", detail: Object.keys(st().agentPaths).join(", ") || "détection automatique", value: "/detect" },
        ]
        return openList("Réglages", entries, (cmd) => { closeOverlay(); setTimeout(() => runCommand(cmd), 0) })
      }
      case "update": {
        flash("Lecture des versions…")
        const latest = async (pkg: string) => {
          const r = await runCmd(["npm", "view", pkg, "version"], { timeoutMs: 15_000 })
          return r.code === 0 ? r.out.trim() : "?"
        }
        const d = detected()
        const ver = (id: string) => d.find((x) => x.id === id)?.version ?? "non installé"
        // OpenCode s'installe ici par son propre installateur : le paquet npm « opencode-ai » ne suit pas la même version
        const [cc, cx, gm] = await Promise.all(["@anthropic-ai/claude-code", "@openai/codex", "@google/gemini-cli"].map(latest))
        return note([
          `Eclipse     ${VERSION} · ${VERSION_INFO()}`,
          `Bun         ${Bun.version}`,
          `Claude Code ${ver("claude")}   (dernière publiée : ${cc})`,
          `Codex CLI   ${ver("codex")}   (dernière : ${cx})`,
          `OpenCode    ${ver("opencode")}   (dernière : vérifiable avec « opencode upgrade », son propre installateur)`,
          `Gemini CLI  ${ver("gemini")}   (dernière : ${gm})`,
          "Mise à jour d'un agent : sa propre commande (ex. claude update, npm install -g @openai/codex). Eclipse ne met rien à jour sans vous.",
        ].join("\n"))
      }
      case "restart": {
        mem.close()
        budget.close()
        await renderer.destroy()
        const child = Bun.spawn(process.argv, { stdio: ["inherit", "inherit", "inherit"], cwd: process.cwd(), env: process.env })
        process.exit(await child.exited)
      }
      case "timeline": {
        const users = items.map((x, i) => ({ x, i })).filter(({ x }) => x.role === "user")
        if (!users.length) return note("Aucun message dans cette discussion.", "warn")
        return openList("Aller à un message", () => users.map(({ x, i }, n) => ({ title: `${n + 1}. ${x.text.split("\n")[0].slice(0, 26)}`, detail: x.text.replace(/\s+/g, " ").slice(26, 90), value: String(i) })),
                        (v) => { closeOverlay(); setTimeout(() => threadScroll?.scrollChildIntoView(`msg-${v}`, { align: "start" }), 0) })
      }
      case "sidebar":
        updatePrefs({ sidebar: !sidebarOn() })
        return flash(sidebarOn() ? (dims().width >= 110 ? "Barre latérale affichée" : "Barre latérale activée (visible à partir de 110 colonnes)") : "Barre latérale masquée")
      case "permissions": {
        const apply = async (m: string) => {
          closeOverlay()
          if ((m === "bypass" || m === "bypass-total") && !perms.bypassVerified) {
            flash("Vérification du mot de passe de l'ordinateur…")
            await renderer.suspend() // la fenêtre du système, ou son invite texte, prend la main
            const r = await verifyPassword()
            await renderer.resume()
            if (!r.ok) return note(`Bypass refusé : ${r.reason}.`, "error")
            perms.bypassVerified = true
          }
          perms.setMode(m as PermMode)
          setPermMode(m as PermMode)
          note(`Permissions : ${m} — ${PERM_LABEL[m as PermMode]}${m.startsWith("bypass") ? " (jusqu'à la fermeture d'Eclipse)" : ""}`, m.startsWith("bypass") ? "warn" : "info")
        }
        const alias: Record<string, string> = { ask: "demander", edits: "modifications", readonly: "lecture", plan: "lecture", all: "bypass-total", total: "bypass-total" }
        const a = alias[arg] ?? arg
        if (a && a in PERM_LABEL) return apply(a)
        return openList("Permissions", () => (Object.keys(PERM_LABEL) as PermMode[]).map((m) => ({ title: m, detail: PERM_LABEL[m] + (m === permMode() ? "  (actuel)" : ""), value: m })), apply)
      }
      case "bypass": {
        if (arg === "off") return runCommand("/permissions demander")
        return runCommand(arg === "all" || arg === "total" ? "/permissions bypass-total" : "/permissions bypass")
      }
      case "add-dir": {
        if (!arg) return note(`Dossiers autorisés : ${[cwd(), ...extraDirs()].map(short).join(", ")}\nUsage : /add-dir CHEMIN`)
        const d = resolvePath(cwd(), arg.replace(/^~/, home()))
        if (!existsSync(d) || !statSync(d).isDirectory()) return note(`Dossier introuvable : ${d}`, "error")
        setExtraDirs((x) => [...new Set([...x, d])])
        return flash(`Dossier autorisé en plus du projet : ${short(d)}`)
      }
      case "undo": {
        if (busy()) return flash(t("Une réponse est en cours (échap pour interrompre)."))
        const e = undoStack.pop()
        if (!e) {
          const text = dropLastExchange()
          return note(text ? "Dernier échange retiré (aucun fichier n'avait été modifié)." : "Rien à annuler.", text ? "info" : "warn")
        }
        const snaps = new Snapshots(cwd())
        const after = await snaps.snapshot(`après : ${e.label}`)
        const r = await snaps.restore(e.before)
        if (!r.ok) return note(`Annulation impossible : ${r.error}`, "error")
        if (after) redoStack.push({ after, label: e.label })
        dropLastExchange()
        return note(`Annulé : « ${e.label} »\n` + (r.changed.length ? r.changed.slice(0, 20).map((x) => "  " + x).join("\n") : "  aucun fichier à restaurer") + "\n/redo pour rétablir les fichiers")
      }
      case "redo": {
        const e = redoStack.pop()
        if (!e) return note("Rien à rétablir.", "warn")
        const snaps = new Snapshots(cwd())
        const before = await snaps.snapshot(`avant rétablissement : ${e.label}`)
        const r = await snaps.restore(e.after)
        if (!r.ok) return note(`Rétablissement impossible : ${r.error}`, "error")
        if (before) undoStack.push({ before, label: e.label })
        return note(`Fichiers rétablis : « ${e.label} »\n` + r.changed.slice(0, 20).map((x) => "  " + x).join("\n"))
      }
      case "attach": {
        if (!arg) return note(attachments().length ? `Joint au prochain message : ${attachments().join(", ")}` : "Usage : /attach CHEMIN (ou @chemin dans le message)")
        const abs = resolvePath(cwd(), arg.replace(/^~/, home()))
        if (!existsSync(abs) || !statSync(abs).isFile()) return note(`Fichier introuvable : ${abs}`, "error")
        setAttachments((x) => [...x, abs])
        return flash(`Joint au prochain message : ${short(abs)}`)
      }
      case "todo": {
        const [sub, ...r] = arg.split(/\s+/)
        const rest3 = r.join(" ")
        const n = Number(rest3) - 1
        if (sub === "add" && rest3) todoList.push({ text: rest3, status: "à faire" })
        else if ((sub === "doing" || sub === "done") && todoList[n]) todoList[n].status = sub === "done" ? "fait" : "en cours"
        else if (sub === "clear") todoList.splice(0)
        else if (sub) return note("Usage : /todo add TEXTE | doing N | done N | clear", "error")
        syncTodos()
        return note(todoList.length ? "Tâches :\n" + todoList.map((x, i) => `  ${i + 1}. [${x.status}] ${x.text}`).join("\n") : "Aucune tâche. /todo add TEXTE")
      }
      case "init":
        setItems(items.length, { role: "user", text: "/init" })
        mem.append(ensureConv("/init"), "user", "/init")
        return ask("Analyse ce projet (structure, langages, commandes de build et de test, conventions) puis crée ou mets à jour le fichier AGENTS.md à la racine avec des consignes concises et utiles pour un agent de programmation. S'il existe déjà, améliore-le sans perdre son contenu utile.")
      case "review": {
        const kind = arg || "uncommitted"
        let cmd: string[]
        if (kind === "commit") cmd = ["git", "-C", cwd(), "show", "--stat", "-p", "HEAD"]
        else if (kind === "branch") {
          const base = (await runCmd(["git", "-C", cwd(), "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { timeoutMs: 5000 })).out.trim() || "main"
          cmd = ["git", "-C", cwd(), "diff", `${base}...HEAD`]
        } else if (kind === "pr") {
          if (!Bun.which("gh")) return note("/review pr demande la commande gh (GitHub CLI).", "error")
          cmd = ["gh", "pr", "diff"]
        } else cmd = ["git", "-C", cwd(), "diff", "HEAD"]
        const d = await runCmd(cmd, { cwd: cwd(), timeoutMs: 20_000 })
        if (d.code !== 0) return note(`Impossible de lire les changements : ${d.err.trim().split("\n")[0]}`, "error")
        const untracked = kind === "uncommitted" ? (await runCmd(["git", "-C", cwd(), "ls-files", "--others", "--exclude-standard"], { timeoutMs: 10_000 })).out.trim() : ""
        if (!d.out.trim() && !untracked) return note("Aucun changement à relire.", "warn")
        const diff = d.out.length > 60_000 ? d.out.slice(0, 60_000) + "\n… (coupé)" : d.out
        setItems(items.length, { role: "user", text: `/review ${kind}` })
        mem.append(ensureConv(`/review ${kind}`), "user", `/review ${kind}`)
        return ask(`Relis ces changements comme un relecteur exigeant : bugs, régressions, sécurité, tests manquants. Donne fichier et ligne pour chaque remarque, du plus grave au moins grave. Ne modifie rien.\n\n${untracked ? "Fichiers non suivis :\n" + untracked + "\n\n" : ""}\`\`\`diff\n${diff}\n\`\`\``, { readOnly: true })
      }
      case "goal": {
        const g = goal()
        if (arg === "pause") return g ? (setGoal({ ...g, active: false }), flash("Objectif en pause")) : note("Aucun objectif.", "warn")
        if (arg === "resume") {
          if (!g) return note("Aucun objectif.", "warn")
          setGoal({ ...g, active: true, rounds: 0 })
          return send(`Continue vers l'objectif : ${g.text}\nQuand il est entièrement atteint et vérifié, termine ta réponse par la ligne « OBJECTIF ATTEINT ».`)
        }
        if (arg === "clear") return setGoal(null), flash("Objectif effacé")
        if (!arg) return note(g ? `Objectif : ${g.text} (${g.active ? "en cours" : "en pause"}, ${g.rounds} tour(s))\n/goal pause · resume · clear` : "Usage : /goal OBJECTIF — Eclipse continue (20 tours au plus) jusqu'à ce que le modèle confirme « OBJECTIF ATTEINT ».")
        setGoal({ text: arg, active: true, rounds: 0 })
        return send(`Objectif : ${arg}\nTravaille jusqu'à ce qu'il soit entièrement atteint et vérifié (tests compris si c'est du code). Quand c'est le cas, termine ta réponse par la ligne « OBJECTIF ATTEINT ».`)
      }
      case "sandbox": {
        const av = sandboxAvailable()
        if (!av.ok) return note(`Sandbox indisponible : ${av.reason}. Les commandes restent soumises aux permissions.`, "warn")
        const on = arg === "on" ? true : arg === "off" ? false : !sandboxOn()
        updatePrefs({ sandbox: on })
        return note(on ? `Sandbox active (${av.tool}) : les commandes des modèles et des agents n'écrivent que dans le projet, /tmp et les caches de build.`
                       : "Sandbox désactivée : les commandes autorisées peuvent écrire partout où vous le pouvez, sauf dans les fichiers d'Eclipse. /sandbox pour la réactiver.", on ? "info" : "warn")
      }
      case "details":
        setShowDetails((x) => !x)
        return flash(showDetails() ? "Détail des outils affiché" : "Détail des outils masqué (une ligne par outil)")
      case "system": {
        const [sub, ...r] = arg.split(/\s+/)
        const txt = r.join(" ").trim()
        if (sub === "set") {
          updatePrefs({ system: txt || undefined })
          return note(txt ? "Consignes personnelles enregistrées : envoyées aux modèles d'API à chaque message." : "Consignes personnelles effacées.")
        }
        if (sub === "project") {
          if (!txt) return note("Usage : /system project TEXTE — ajouté à .eclipse/instructions.md du projet", "error")
          mkdirSync(join(cwd(), ".eclipse"), { recursive: true })
          const f = join(cwd(), ".eclipse", "instructions.md")
          writeFileSync(f, (existsSync(f) ? readFileSync(f, "utf8").replace(/\n*$/, "\n") : "") + txt + "\n")
          return note(`Consigne ajoutée à ${short(f)}`)
        }
        if (sub === "clear") return updatePrefs({ system: undefined }), note("Consignes personnelles effacées.")
        const i = instructions()
        return note((i ? `Consignes envoyées aux modèles d'API :\n\n${i.slice(0, 3000)}${i.length > 3000 ? "\n…" : ""}` : "Aucune consigne : ni personnelle, ni AGENTS.md, CLAUDE.md ou .eclipse/instructions.md dans ce projet.") +
                    "\n\n/system set TEXTE · /system project TEXTE · /system clear")
      }
      case "compact": {
        const cur = current()
        if (cur?.kind === "agent") return note(`${agentName(cur.provider)} compacte lui-même sa session ; Eclipse garde l'archive complète.`, "info")
        if (!cur?.model) return note("Aucun modèle choisi : /models", "warn")
        if (history.length < 4) return note("Discussion trop courte pour être compactée.", "warn")
        if (!conv) return note("Rien à compacter.", "warn")
        const p = provider(cur.provider)!
        flash("Compactage en cours…")
        setBusy(true)
        const before = history.reduce((n, m) => n + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")), 0)
        let sum = ""
        const transcript = history.map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${typeof m.content === "string" ? m.content : ""}`).join("\n\n").slice(-120_000)
        for await (const e of streamChat(p, cur.model, [{ role: "user", content: "Résume fidèlement cette discussion pour pouvoir la continuer : objectifs, décisions et leurs raisons, fichiers concernés, état actuel, questions ouvertes. N'invente rien ; en français ; 400 mots au plus.\n\n" + transcript }])) {
          if (e.type === "text") sum += e.text
          else if (e.type === "error") {
            setBusy(false)
            return note(`Compactage impossible : ${e.message}`, "error")
          }
        }
        setBusy(false)
        if (!sum.trim()) return note("Compactage : réponse vide, rien n'a changé.", "warn")
        const rows = mem.messages(conv)
        const sid = mem.addSummary(district(), conv, sum, rows[0]?.id ?? 0, rows[rows.length - 1]?.id ?? 0, `modèle ${cur.model}`)
        history = [{ role: "user", content: "Résumé de la discussion jusqu'ici (vérifiable avec /verify " + sid + ") :\n" + sum }, { role: "assistant", content: "Compris, je continue à partir de ce résumé." }]
        return note(`Discussion compactée (résumé n° ${sid}) : ≈ ${before} → ${estimateTokens(sum)} tokens transmis désormais. L'archive complète est conservée. /verify ${sid} pour contrôler le résumé.`)
      }
      case "verify": {
        const id = Number(arg)
        const s = id ? mem.summary(id) : null
        if (!s) return note(`Usage : /verify ID — résumés de cette discussion : ${conv ? mem.summaries(conv).map((x) => x.id).join(", ") || "aucun" : "aucun"}`, "error")
        const cur = current()
        if (cur?.kind !== "api" || !cur.model) return note("/verify utilise le modèle d'API choisi : /models", "warn")
        const src = mem.archiveRange(s.conversation_id, s.from_archive_id, s.to_archive_id).map((r) => `${r.role} : ${r.content}`).join("\n\n").slice(-100_000)
        let out = ""
        flash("Vérification du résumé…")
        for await (const e of streamChat(provider(cur.provider)!, cur.model, [{ role: "user", content: `Compare ce résumé à la discussion d'origine. Liste chaque affirmation du résumé qui est fausse, absente des sources ou déformée, puis conclus par une ligne « FIDÈLE: OUI » ou « FIDÈLE: NON ».\n\nRÉSUMÉ :\n${s.content}\n\nSOURCES :\n${src}` }])) {
          if (e.type === "text") out += e.text
          else if (e.type === "error") return note(`Vérification impossible : ${e.message}`, "error")
        }
        const ok = /FID[ÈE]LE\s*:\s*OUI/i.test(out)
        const ko = /FID[ÈE]LE\s*:\s*NON/i.test(out)
        if (ok || ko) mem.setVerified(id, ok)
        return setItems(items.length, { role: "assistant", text: `### Vérification du résumé n° ${id} : ${ok ? "fidèle" : ko ? "écarts trouvés" : "sans conclusion claire"}\n\n${out}` })
      }
      case "skills": {
        skills = discoverSkills(cwd())
        if (!skills.length) return note("Aucun skill trouvé (.eclipse/skills, .claude/skills, ~/.claude/skills, ~/.config/eclipse/skills…).", "warn")
        return openList(`Skills (${skills.length})`, () => skills.map((s) => ({ title: s.name, detail: s.description, right: s.scope, value: s.name })),
                        (v) => { closeOverlay(); prompt?.setText(`Utilise le skill « ${v} » pour : `); setDraft(prompt?.plainText ?? "") }, "entrée : l'utiliser dans le prochain message · échap")
      }
      case "plugins": {
        const [sub, nm] = arg.split(/\s+/)
        plugins = discoverPlugins(cwd())
        if ((sub === "trust" || sub === "untrust") && nm) {
          const pl = plugins.find((x) => x.name === nm)
          if (!pl) return note(`Plugin inconnu : ${nm}`, "error")
          setTrust(pl, sub === "trust")
          await loadExtensions()
          const now2 = plugins.find((x) => x.name === nm)
          return note(sub === "trust" ? (now2?.error ? `Plugin ${nm} : confiance donnée, mais erreur au chargement : ${now2.error}` : `Plugin ${nm} : confiance donnée et chargé (${pluginCmds.filter((x) => x.plugin === nm).map((x) => "/" + x.name).join(", ") || "aucune commande"}).`)
                                    : `Plugin ${nm} : confiance retirée (il ne sera plus exécuté).`)
        }
        if (!plugins.length) return note("Aucun plugin (.eclipse/plugins ou ~/.config/eclipse/plugins, fichiers .ts ou .js). Un plugin exporte par défaut une fonction (api) => { api.command(nom, description, (arg) => texte) }.")
        return note("Plugins :\n" + plugins.map((x) => `  ${x.name.padEnd(20)} ${x.scope.padEnd(7)} ${x.trusted ? (x.loaded ? "chargé" : `erreur : ${x.error}`) : "non exécuté (pas de confiance)"}`).join("\n") +
                    "\n\n/plugins trust NOM · /plugins untrust NOM — la confiance porte sur le contenu exact du fichier.")
      }
      case "mcp": {
        if (arg === "reload") {
          await mcp.start(cwd(), () => setMcpTick((x) => x + 1))
          return flash("Serveurs MCP relancés")
        }
        const [sub, ...rest] = arg.split(/\s+/)
        if (sub === "approuver" || sub === "retirer") {
          const name = rest.join(" ").trim()
          const all = name === "--tous"
          if (!name) return note(`Usage : /mcp ${sub} NOM (serveur déclaré dans .eclipse/mcp.json du projet) ou /mcp ${sub} --tous`, "error")
          if (sub === "retirer") {
            await mcp.stopAll() // arrête aussi un démarrage en cours
            const gone = revokeMcp(cwd(), name, all)
            mcp.start(cwd(), () => setMcpTick((x) => x + 1))
            return note(gone.length ? `Approbation retirée et serveur arrêté : ${gone.join(", ")}` : `Aucune approbation pour « ${name} » dans ce projet.`)
          }
          // la configuration est lue UNE fois, montrée en entier, et c'est elle qui est approuvée (jamais une relecture).
          // Confirmation demandée même en bypass : lancer un programme fourni par un dépôt est une décision de l'utilisateur.
          const pend = pendingProject(cwd()).filter((x) => all || x.name === name)
          if (!pend.length) return note(`Rien à approuver sous ce nom. /mcp montre les serveurs du projet en attente.`, "error")
          const ok: string[] = []
          for (const x of pend) {
            const d = await new Promise<Decision>((res) => later({ type: "perm", resolve: res, req: {
              tool: "mcp", kind: "exec", destructive: true, grantKey: "mcp-projet", mustRead: true,
              summary: `Lancer le serveur MCP « ${x.name} » déclaré par ce projet (.eclipse/mcp.json)`,
              detail: revealHidden(JSON.stringify(x.cfg, null, 2) + (x.files.length ? `\n\nFichiers du projet suivis (l'approbation tombe s'ils changent) : ${x.files.join(", ")}` : "")),
            } }))
            if (d === "deny") continue
            approveMcpFingerprint(cwd(), x.name, x.fp)
            ok.push(x.name)
          }
          if (!ok.length) return note("Rien n'a été approuvé.")
          await mcp.start(cwd(), () => setMcpTick((x) => x + 1))
          const still = mcp.status.filter((x) => ok.includes(x.name) && x.state === "à approuver")
          return note(still.length ? `Le fichier a changé pendant la confirmation : ${still.map((x) => x.name).join(", ")} toujours en attente.` : `Approuvé et lancé : ${ok.join(", ")}`, still.length ? "warn" : "info")
        }
        mcpTick()
        if (!mcp.status.length) return note(`Aucun serveur MCP configuré. Fichier : ${short(join(dataDir(), "mcp.json"))} (ou .eclipse/mcp.json du projet), format {"mcpServers": {"nom": {"command": "…", "args": []}}}.`)
        const waiting = mcp.status.filter((s) => s.state === "à approuver")
        return note("Serveurs MCP (outils donnés aux modèles d'API) :\n" + mcp.status.map((s) => `  ${s.state === "connecté" ? I.ok : s.state === "erreur" ? I.error : s.state === "à approuver" ? I.warn : I.off} ${s.name.padEnd(20)} ${s.state}${s.tools ? ` · ${s.tools} outil(s)` : ""}${s.error ? " · " + s.error : ""} (${s.source})${s.launch ? `\n      lancerait : ${s.launch}` : ""}`).join("\n")
          + (waiting.length ? `\n\nServeurs déclarés par le projet : rien n'est lancé sans votre accord. Vérifiez la commande, puis /mcp approuver NOM (ou --tous).` : "") + "\n\n/mcp reload pour relancer")
      }
      case "fusion": {
        const [sub, ...r] = arg.split(/\s+/)
        const id = r.join(" ")
        const list = prefs().fusion ?? []
        if (sub === "add" && id) {
          const ok = id.startsWith("agent:") ? !!detected().find((x) => x.id === id.slice(6))?.installed : !!provider(id.split("/")[0])
          if (!ok) return note(`Assistant introuvable : ${id}. Formats : agent:codex, agent:claude, poe/claude-haiku-5.5, openrouter/…`, "error")
          updatePrefs({ fusion: [...new Set([...list, id])], fusionOn: true })
          return note(`Fusion : ${id} ajouté. Le modèle d'API actif peut le consulter (outil ask_helper, en lecture seule).`)
        }
        if (sub === "remove" && id) return updatePrefs({ fusion: list.filter((x) => x !== id) }), note(`Fusion : ${id} retiré.`)
        if (sub === "on" || sub === "off") return updatePrefs({ fusionOn: sub === "on" }), note(`Fusion ${sub === "on" ? "activée" : "désactivée"}.`)
        return note(`Fusion ${prefs().fusionOn === false ? "désactivée" : "activée"} · assistants : ${list.join(", ") || "aucun"}\n/fusion add agent:codex | add poe/MODÈLE | remove ID | on | off`)
      }
      case "automation": {
        const [sub, a1, ...r] = arg.split(/\s+/)
        const autos = prefs().automations ?? []
        if (sub === "add") {
          const every = parseDuration(a1 ?? "")
          const txt = r.join(" ").trim()
          if (!every || every < 60 || !txt) return note("Usage : /automation add 30m TEXTE (1 minute au moins) — envoyé à intervalle régulier tant qu'Eclipse est ouvert", "error")
          const id = Math.max(0, ...autos.map((x) => x.id)) + 1
          updatePrefs({ automations: [...autos, { id, every, prompt: txt, last: Date.now() }] })
          return note(`Automatisation n° ${id} : « ${txt} » toutes les ${a1}, tant qu'Eclipse est ouvert (rien ne tourne quand il est fermé).`)
        }
        const n = Number(a1)
        if ((sub === "pause" || sub === "resume") && autos.some((x) => x.id === n))
          return updatePrefs({ automations: autos.map((x) => (x.id === n ? { ...x, paused: sub === "pause" } : x)) }), flash(`Automatisation n° ${n} ${sub === "pause" ? "en pause" : "reprise"}`)
        if (sub === "delete" && autos.some((x) => x.id === n)) return updatePrefs({ automations: autos.filter((x) => x.id !== n) }), flash(`Automatisation n° ${n} supprimée`)
        return note((autos.length ? "Automatisations :\n" + autos.map((x) => `  ${x.id}. toutes les ${Math.round(x.every / 60)} min${x.paused ? " (en pause)" : ""} : ${x.prompt.slice(0, 80)}`).join("\n") : "Aucune automatisation.") +
                    "\n\n/automation add 30m TEXTE · pause N · resume N · delete N")
      }
      case "highlights":
        return setItems(items.length, { role: "assistant", text: HIGHLIGHTS })
      case "help":
        return openList(t("Commandes"), () => [
          { title: "PRÊTES", header: true },
          ...COMMANDS.filter((x) => x.ready).map((x) => ({ title: "/" + x.name, detail: x.desc + (x.aliases?.length ? ` (aussi /${x.aliases.join(", /")})` : ""), right: x.keys ?? x.origin, value: x.name })),
          { title: "À VENIR", header: true },
          ...COMMANDS.filter((x) => !x.ready).map((x) => ({ title: "/" + x.name, detail: `${x.desc} — étape « ${x.step} »`, right: x.origin, dim: true })),
        ], (v) => { closeOverlay(); prompt?.setText("/" + v + " "); setDraft("/" + v + " ") }, "↑↓ · entrée : écrire la commande · tapez pour filtrer · échap")
      case "exit":
        if (voiceOn()) hangUp()
        await mcp.stopAll()
        mem.close()
        budget.close()
        return renderer.destroy()
    }
  }

  /** « !commande » : commande shell lancée dans le dossier, avec la même autorisation que pour un modèle. */
  async function runShell(cmd: string) {
    if (!cmd) return
    const ti = items.length
    setItems(ti, { role: "tool", tool: "commande", text: cmd, running: true })
    const r = await runTool({ roots: [cwd(), ...extraDirs()], perms, memory: mem, districtId: district(), todos: todoList, sandbox: sandboxOn() },
                            { id: "shell", name: "run_command", args: JSON.stringify({ command: cmd }) })
    setItems(ti, produce((it) => { it.running = false; it.ok = r.ok; it.output = r.output }))
  }

  function submit() {
    const text = (prompt?.plainText ?? "").trim()
    if (!text) return
    // pendant une réponse : les commandes qui n'envoient rien restent utilisables (/usage, /status, /help, /memory…)
    if (busy()) {
      const c0 = text.startsWith("/") ? resolve(text.slice(1).split(/\s/)[0]) ?? slashMatches()[Math.min(slashSel(), Math.max(0, slashMatches().length - 1))] : undefined
      if (!c0 || BUSY_BLOCKED.has(c0.name)) return flash(t("Une réponse est en cours (échap pour interrompre)."))
    }
    remember(text)
    const sug = slashMatches()
    const chosen = sug[Math.min(slashSel(), sug.length - 1)] // relevé AVANT de vider la saisie (qui remet la sélection à zéro)
    prompt?.clear()
    setDraft("")
    if (text.startsWith("!") && text.length > 1) return runShell(text.slice(1).trim())
    if (text.startsWith("/")) {
      const exact = resolve(text.slice(1).split(/\s/)[0])
      // « /pe » + Entrée : la commande sélectionnée dans la liste (↑↓), comme dans OpenCode
      runCommand(exact || !chosen ? text : "/" + chosen.name)
    } else send(text)
  }

  // liste des commandes pendant la frappe : ↑↓ pour choisir, Entrée pour lancer, Tab pour compléter, Échap pour fermer
  const [slashSel, setSlashSel] = createSignal(0)
  const [slashHidden, setSlashHidden] = createSignal("")
  const slashMatches = createMemo(() => {
    const d = draft()
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n") || slashHidden() === d) return []
    return suggest(d.slice(1), 100)
  })
  createEffect(on(draft, () => setSlashSel(0)))
  const SLASH_ROWS = 8
  // rappel des messages précédents (↑ ↓ quand la saisie tient sur une ligne) : ceux du projet, puis ceux de la session
  const promptHistory: string[] = (mem.db.query(`SELECT a.content FROM archive a JOIN conversations c ON c.id=a.conversation_id
      WHERE a.role='user' AND c.district_id=? ORDER BY a.id DESC LIMIT 200`).all(district()) as { content: string }[]).map((r) => r.content).reverse()
  let histPos: number | null = null
  let histDraft = ""
  const remember = (s: string) => {
    if (s.trim() && promptHistory[promptHistory.length - 1] !== s) promptHistory.push(s)
    histPos = null
  }
  const slashStart = createMemo(() => Math.max(0, Math.min(slashSel() - Math.floor(SLASH_ROWS / 2), slashMatches().length - SLASH_ROWS)))

  useKeyboard((k) => {
    if (overlay()) return
    // /cg : Alt+← → passent d'un onglet à l'autre (vue d'ensemble, agents, sous-agents)
    if (cgOn() && k.meta && (k.name === "left" || k.name === "right")) {
      const tabs = cgTabs(zones)
      const i = Math.max(0, tabs.findIndex((x) => x.id === cgTab()))
      setCgTab(tabs[(i + (k.name === "right" ? 1 : -1) + tabs.length) % tabs.length].id)
      k.preventDefault()
      k.stopPropagation()
      return
    }
    const sm = slashMatches()
    if (sm.length && !leader() && ["up", "down", "pageup", "pagedown", "escape", "tab"].includes(k.name) && !(k.name === "tab" && k.shift)) {
      k.preventDefault() // la zone de saisie ne reçoit pas ces touches : elles pilotent la liste
      k.stopPropagation()
      if (k.name === "down") setSlashSel((s) => (s + 1) % sm.length)
      else if (k.name === "up") setSlashSel((s) => (s - 1 + sm.length) % sm.length)
      else if (k.name === "pagedown") setSlashSel((s) => Math.min(sm.length - 1, s + SLASH_ROWS))
      else if (k.name === "pageup") setSlashSel((s) => Math.max(0, s - SLASH_ROWS))
      else if (k.name === "escape") setSlashHidden(draft())
      else if (k.name === "tab") {
        prompt?.setText("/" + sm[Math.min(slashSel(), sm.length - 1)].name + " ")
        setDraft(prompt?.plainText ?? "")
      }
      return
    }
    // historique : ↑ remonte, ↓ redescend (puis retrouve le brouillon)
    const cur = prompt?.plainText ?? ""
    if (!sm.length && !leader() && (k.name === "up" || k.name === "down") && !k.ctrl && !k.meta && !cur.includes("\n") && promptHistory.length) {
      if (k.name === "up") {
        if (histPos === null) {
          histDraft = cur
          histPos = promptHistory.length
        }
        if (histPos > 0) histPos--
      } else {
        if (histPos === null) return
        histPos++
      }
      k.preventDefault()
      k.stopPropagation()
      const v = histPos !== null && histPos < promptHistory.length ? promptHistory[histPos] : histDraft
      if (histPos !== null && histPos >= promptHistory.length) histPos = null
      prompt?.setText(v)
      setDraft(v)
      setSlashHidden(v) // un ancien « /commande » rappelé n'ouvre pas la liste
      return
    }
    if (leader()) {
      setLeader(false)
      const map: Record<string, string> = { m: "/models", n: "/new", l: "/sessions", t: "/themes", u: "/undo", r: "/redo", s: "/status", i: "/usage", y: "/copy", x: "/export", e: "/editor", a: "/agents", p: "/permissions", c: "/compact", g: "/timeline", h: "/details", b: "/sidebar" }
      if (map[k.name]) runCommand(map[k.name])
      return
    }
    if (k.ctrl && k.name === "x") setLeader(true)
    else if (k.ctrl && k.name === "c") {
      if (prompt?.plainText) {
        prompt.clear()
        setDraft("")
      } else if (Date.now() - exitArmed() < 2000) runCommand("/exit")
      else {
        setExitArmed(Date.now())
        flash(t("Ctrl+C encore une fois pour quitter."))
      }
    } else if (k.name === "escape" && stopSpeech) {
      stopSpeech() // coupe la lecture ; l'écoute reprend
    } else if (k.name === "escape" && abort) {
      abort.abort()
      const g = goal()
      if (g?.active) setGoal({ ...g, active: false })
    }
    else if (k.ctrl && k.name === "p") runCommand("/help")
    else if (k.ctrl && k.name === "t") runCommand("/effort")
    else if (k.name === "tab" && k.shift) runCommand("/mode " + (mode() === "build" ? "plan" : "build"))
  })

  const PromptBox = () => (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <Show when={slashMatches().length}>
        <box flexDirection="column" border={["left"]} borderStyle="heavy" borderColor={C.panelBorder} paddingX={1} backgroundColor={C.panel}>
          <For each={slashMatches().slice(slashStart(), slashStart() + SLASH_ROWS)}>
            {(c, i) => {
              const on = () => slashStart() + i() === slashSel()
              return (
                <box flexDirection="row" height={1} backgroundColor={on() ? C.selBg : undefined}>
                  <text fg={on() ? C.accent : C.text} width={16}>{(on() ? "› /" : "  /") + c.name}</text>
                  <text fg={c.ready ? C.muted : C.dim} flexGrow={1}>{c.desc.slice(0, Math.max(10, dims().width - 50)) + (c.ready ? "" : ` (${t("à venir")})`)}</text>
                  <text fg={C.dim}>{c.keys ?? ""}</text>
                </box>
              )
            }}
          </For>
          <Show when={slashMatches().length > SLASH_ROWS}>
            <text fg={C.dim}>{`${slashSel() + 1}/${slashMatches().length} · ↑↓ choisir · entrée lancer · tab compléter · échap fermer`}</text>
          </Show>
        </box>
      </Show>
      <box flexDirection="column" border={["left"]} borderStyle="heavy" borderColor={busy() ? C.warn : mode() === "plan" ? C.other : C.accent} paddingX={2} paddingY={1} backgroundColor={C.panel}>
        <textarea ref={(r: TextareaRenderable) => (prompt = r)} focused={!overlay()} minHeight={1} maxHeight={8}
                  placeholder={items.length ? t("Votre message…") : t("Demandez n'importe quoi…  « Corrige un TODO du projet »")} placeholderColor={C.dim}
                  textColor={C.text} backgroundColor={C.panel} focusedBackgroundColor={C.panel} wrapMode="word"
                  keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" },
                                { name: "j", ctrl: true, action: "newline" }, { name: "return", meta: true, action: "newline" }]}
                  onSubmit={submit} onContentChange={() => setDraft(prompt?.plainText ?? "")} />
        <box flexDirection="row" marginTop={1} height={1}>
          <text fg={mode() === "plan" ? C.other : C.accent}><b>{mode() === "plan" ? "Plan" : "Build"}</b></text>
          <text fg={C.muted}>{"  " + (cgOn() ? "Claude Code et Codex (/cg)" : currentLabel())}</text>
          <Show when={permMode() !== "demander"}><text fg={permMode().startsWith("bypass") ? C.error : C.other}>{"  · " + permMode().toUpperCase()}</text></Show>
          <Show when={attachments().length}><text fg={C.recent}>{`  · ${attachments().length} pièce(s) jointe(s)`}</text></Show>
          <Show when={goal()?.active}><text fg={C.detected}>{"  · objectif en cours"}</text></Show>
        </box>
        <Show when={voiceOn()}>
          <text fg={C.recent} height={1}>{`${I.agent} Appel vocal · ${voiceState() === "écoute" ? "écoute " + "▁▂▃▄▅▆▇█".slice(0, Math.max(1, Math.round(voiceLevel() * 8))) + " parlez" : voiceState() === "transcription" ? spinner() + " transcription" : voiceState() === "réponse" ? spinner() + " réponse en cours" : spinner() + " lecture (échap pour couper)"} · « raccroche » ou /voice pour terminer`}</text>
        </Show>
        <Show when={busy()}>
          <text fg={C.warn} height={1}>{`${spinner()} ${(activity() || t("en cours…")).slice(0, Math.max(10, dims().width - 50))} · ${elapsed()} · échap pour interrompre`}</text>
        </Show>
      </box>
    </box>
  )

  const Footer = () => (
    <box flexDirection="row" justifyContent="space-between" height={1} width="100%" paddingX={1} flexShrink={0}>
      <text fg={C.dim}>{short(cwd())}</text>
      <text fg={toast() ? C.warn : leader() ? C.accent : C.dim}>
        {toast() || (leader() ? t("ctrl+x : m modèles · n nouvelle discussion · l sessions") : "maj+tab mode   " + t("ctrl+x m modèles   ctrl+p commandes   /help"))}
      </text>
    </box>
  )

  const Sidebar = () => {
    const its = () => mem.items(district()).slice(0, 5)
    const s = () => (usageTick(), conv ? budget.totals(0, { session: sessionKey() }) : null)
    const Head = (p: { t: string; c?: string }) => <text fg={p.c ?? C.accent} marginTop={1}><b>{p.t}</b></text>
    return (
      <box flexDirection="column" width={36} paddingX={1} border={["left"]} borderColor={C.panelBorder}>
        <Head t="Session" c={C.recent} />
        <text fg={C.text}>{(title() || "nouvelle discussion").slice(0, 32)}</text>
        <text fg={C.muted}>{`${items.filter((x) => x.role === "user").length} message(s) · ${mode()}`}</text>
        <Head t="Modèle" c={C.api} />
        <text fg={C.text}>{currentLabel().slice(0, 64)}</text>
        <Head t="Consommation" />
        <text fg={C.muted}>{s()?.requests ? `${s()!.requests} rép. · ↓${s()!.tokensIn.measured + s()!.tokensIn.estimated} ↑${s()!.tokensOut.measured + s()!.tokensOut.estimated}${s()!.usd ? ` · ≈ $${s()!.usd.toFixed(4)}` : ""}` : "rien encore · /usage"}</text>
        <Show when={todos.length}>
          <Head t="Tâches" c={C.other} />
          <For each={todos}>{(x) => <text fg={x.status === "fait" ? C.dim : C.text}>{`${x.status === "fait" ? "[x]" : x.status === "en cours" ? "[>]" : "[ ]"} ${x.text.slice(0, 28)}`}</text>}</For>
        </Show>
        <Head t={`Mémoire (${mem.items(district()).length})`} c={C.detected} />
        <For each={its()}>{(x) => <text fg={C.muted}>{`· ${x.content.slice(0, 31)}`}</text>}</For>
        <Show when={!its().length}><text fg={C.dim}>vide · « retiens que … »</text></Show>
        <Head t="Agents" c={C.detected} />
        <For each={detected().filter((d) => d.installed)}>{(d) => <text fg={C.muted}>{`${I.ok} ${d.label}`}</text>}</For>
        <box flexGrow={1} />
        <text fg={sandboxOn() ? C.ok : C.warn}><b>{sandboxOn() ? `${I.ok} Sandbox active` : `${I.warn} Sandbox désactivée`}</b></text>
        <text fg={C.dim}>{sandboxAvailable().ok ? "/sandbox pour désactiver ou réactiver" : "bubblewrap absent : /sandbox"}</text>
        <Show when={permMode() !== "demander"}><text fg={permMode().startsWith("bypass") ? C.error : C.other}>{"Permissions : " + permMode()}</text></Show>
      </box>
    )
  }

  const Thread = () => (
    <box flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
      <text fg={C.text} height={1} flexShrink={0}><b>{(title() || items.find((i) => i.role === "user")?.text || "").split("\n")[0].slice(0, dims().width - 10)}</b></text>
      <Show when={cgOn()}><CgZones zones={zones} phase={cgPhase()} tick={spinner()} tab={cgTab()} onTab={setCgTab} width={dims().width - (sidebarOn() && dims().width >= 110 ? 36 : 0)} height={dims().height}
                                   onOpenSub={(a, id) => setCgTab(`sub:${a}:${id}`)} /></Show>
      <scrollbox ref={(r: any) => (threadScroll = r)} flexGrow={1} flexShrink={1} minHeight={0} stickyScroll stickyStart="bottom" marginTop={1}>
        <For each={items}>
          {(it, i) => (
            <box id={`msg-${i()}`} flexDirection="column" marginBottom={1}>
              <Show when={it.role === "user"}>
                <box border={["left"]} borderStyle="heavy" borderColor={it.aside ? C.dim : C.userBar} paddingX={2} paddingY={1} backgroundColor={C.panel}>
                  <text fg={C.text}>{(it.aside ? "/btw  " : "") + it.text}</text>
                </box>
              </Show>
              <Show when={it.role === "assistant"}>
                <box flexDirection="column" paddingX={3}>
                  <Show when={it.memory}><text fg={C.dim}>{it.memory}</text></Show>
                  <Show when={it.thinking}>
                    <text fg={C.dim}>{prefs().showThinking ? `${I.think} ${t("Réflexion")} :\n${it.thinking}` : `${I.think} ${t("Réflexion")} · ${it.thinking!.length} caractères (/thinking pour l'afficher)`}</text>
                  </Show>
                  <Show when={it.level === "error"} fallback={<Show when={it.text || !it.streaming} fallback={<text fg={C.dim}>{`${spinner()} ${activity() || "réflexion"}…`}</text>}>
                    <markdown content={it.text} syntaxStyle={md()} streaming={!!it.streaming} /></Show>}>
                    <text fg={C.error}>{I.error + " " + it.text}</text>
                  </Show>
                  <Show when={it.meta}><text fg={C.dim} marginTop={1}>{it.meta}</text></Show>
                </box>
              </Show>
              <Show when={it.role === "tool"}>
                <box flexDirection="column" paddingX={3} border={["left"]} borderColor={it.running ? C.warn : it.ok ? C.ok : C.error} marginLeft={2}>
                  <text fg={C.muted}>{`${it.running ? spinner() : it.ok ? I.ok : I.error} ${it.tool}  ${(it.text ?? "").slice(0, dims().width - 30)}`}</text>
                  <Show when={showDetails() && !it.running && (it.diff || (!it.ok && it.output) || ((it.tool === "run_command" || it.tool === "commande") && it.output))}>
                    <text fg={it.ok ? C.dim : C.error}>{(it.diff ?? it.output ?? "").split("\n").slice(0, 12).join("\n") + ((it.diff ?? it.output ?? "").split("\n").length > 12 ? `\n… ${(it.diff ?? it.output ?? "").split("\n").length - 12} lignes de plus` : "")}</text>
                  </Show>
                </box>
              </Show>
              <Show when={it.role === "notice"}>
                <box paddingX={3}><text fg={it.level === "error" ? C.error : it.level === "warn" ? C.warn : C.muted}>
                  {(it.level === "error" ? I.error + " " : it.level === "warn" ? I.warn + " " : "") + it.text}
                </text></box>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>
      <PromptBox />
    </box>
  )

  return (
    <Show when={ui() + 1} keyed>
      {(_) => (
        <box flexDirection="column" width={dims().width} height={dims().height}>
          <Show when={items.length} fallback={
            <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
              <box flexDirection="column" alignItems="center">
                <For each={LOGO}>{(l) => <text fg={C.accent}><b>{l}</b></text>}</For>
                <text fg={C.dim} marginTop={1}>{"Eclipse " + VERSION}</text>
              </box>
              <box width={Math.min(80, dims().width - 4)} marginTop={2}><PromptBox /></box>
            </box>
          }>
            <box flexDirection="row" flexGrow={1}>
              <box flexDirection="column" flexGrow={1}><Thread /></box>
              <Show when={sidebarOn() && dims().width >= 110}><Sidebar /></Show>
            </box>
          </Show>
          <Footer />
          <Show when={(() => { const o = overlay(); return o?.type === "models" ? o : null })()}>
            {(o) => (
              <Picker state={st} detected={detected} status={() => status} width={() => dims().width} height={() => dims().height} initialView={o().view}
                      onChoose={pick} onClose={closeOverlay} onOpenProvider={(id) => loadProvider(id)} onNeedKey={(id) => later({ type: "key", id })} />
            )}
          </Show>
          <Show when={(() => { const o = overlay(); return o?.type === "list" ? o : null })()}>
            {(o) => <ListPicker title={o().title} entries={o().entries} onPick={o().onPick} onClose={closeOverlay} hint={o().hint} width={() => dims().width} height={() => dims().height} />}
          </Show>
          <Show when={(() => { const o = overlay(); return o?.type === "text" ? o : null })()}>
            {(o) => <TextPrompt title={o().title} note={o().note} initial={o().initial} width={() => dims().width} onCancel={closeOverlay} onSubmit={(v) => { closeOverlay(); o().onSubmit(v) }} />}
          </Show>
          <Show when={(() => { const o = overlay(); return o?.type === "perm" ? o : null })()}>
            {(o) => <PermissionPrompt req={o().req} width={() => dims().width} height={() => dims().height} onDecide={(d) => { const r = o().resolve; closeOverlay(); r(d) }} />}
          </Show>
          <Show when={overlay()?.type === "cgmenu"}>
            <CgMenu active={cgOn()} width={() => dims().width} height={() => dims().height} models={cgModels}
                    installed={(a) => !!detected().find((x) => x.id === a)?.installed}
                    settings={() => ({ lead: prefs().cgLead ?? "codex", mode: prefs().cgMode ?? "auto", review: prefs().cgReview !== false, subagents: prefs().cgSubagents !== false,
                                       agents: { claude: prefs().agents?.claude ?? {}, codex: prefs().agents?.codex ?? {} } })}
                    update={(s) => updatePrefs({ ...(s.lead ? { cgLead: s.lead } : {}), ...(s.mode ? { cgMode: s.mode } : {}), ...(s.review !== undefined ? { cgReview: s.review } : {}), ...(s.subagents !== undefined ? { cgSubagents: s.subagents } : {}) })}
                    setAgent={(a, s) => updatePrefs({ agents: { ...(prefs().agents ?? {}), [a]: { ...(prefs().agents?.[a] ?? {}), ...s } } })}
                    onStart={() => { closeOverlay(); setTimeout(startCg, 0) }} onClose={closeOverlay} />
          </Show>
          <Show when={(() => { const o = overlay(); return o?.type === "sub" ? o : null })()}>
            {(o) => <SubAgentView agent={o().agent} zone={zones[o().agent]} id={o().id} width={() => dims().width} height={() => dims().height}
                                  onMove={(id) => setOverlay({ type: "sub", agent: o().agent, id })} onClose={closeOverlay} />}
          </Show>
          <Show when={overlay()?.type === "usage"}>
            <UsageScreen budget={budget} session={conv ? sessionKey() : null} rate={rate()} onClose={closeOverlay} width={() => dims().width} height={() => dims().height}
                         current={(() => {
                           const c = current()
                           const mi = modelInfo(c)
                           if (!c) return { label: "aucun (/models)", billing: "—" }
                           if (c.kind === "agent") return { label: agentName(c.provider) + " (agent)", provider: c.provider, billing: "abonnement de l'agent (quotas gérés par lui, non communiqués à Eclipse)" }
                           const pv = provider(c.provider)
                           return { label: `${pv?.label} · ${c.model}`, provider: c.provider, model: c.model, priceIn: mi?.priceIn, priceOut: mi?.priceOut,
                                    billing: pv?.local ? "gratuit (serveur local)" : c.provider === "poe" ? "points Poe (prélevés sur ton compte)" : "facturation à l'usage par le fournisseur" }
                         })()} />
          </Show>
          <Show when={(() => { const o = overlay(); return o?.type === "key" ? o : null })()}>
            {(o) => (
              <KeyPrompt label={provider(o().id)?.label ?? o().id} width={() => dims().width}
                         note={(status[o().id]?.key === "invalid" ? `${status[o().id]!.keyNote}. Saisissez la nouvelle clé. ` : "") + "Vérifiée puis stockée dans le trousseau du système, jamais affichée ni écrite en clair."}
                         onCancel={() => (current() ? closeOverlay() : openModels())}
                         onSubmit={async (key) => {
                           const id = o().id
                           const pv = provider(id)!
                           flash(t("Vérification de la clé…"))
                           const v = await verifyKey(pv, { key })
                           if (v.check === "refusée") return flash(`${pv.label} refuse cette clé : vérifiez-la et recommencez.`)
                           const r = await setKey(id, key)
                           flash(r.ok ? (v.check === "valide" ? "Clé acceptée et enregistrée dans le trousseau" : `Clé enregistrée (${v.detail})`) : r.message)
                           if (!r.ok) return
                           const cur = current()
                           if (cur?.kind === "api" && cur.provider === id) closeOverlay()
                           else openModels(id)
                           loadProvider(id, true)
                         }} />
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}
