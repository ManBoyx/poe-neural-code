/** Interface d'Eclipse, disposition façon OpenCode : accueil centré, fil de discussion, zone de saisie, barre du bas. */
import { batch, createMemo, createSignal, For, onMount, Show } from "solid-js"
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
import { PermissionPrompt } from "./PermissionPrompt"
import { Permissions, PERM_LABEL, type Decision, type PermMode, type Request } from "../core/permissions"
import { openAiTools, READ_ONLY_TOOLS, runTool, summarize, type Todo, type ToolEnv } from "../core/tools"
import { Snapshots } from "../core/snapshots"
import { verifyPassword } from "../core/auth"
import { coerce } from "../core/providers"
import { VERSION_INFO } from "../core/version"
import { Picker, type ProviderStatus } from "./Picker"
import { KeyPrompt } from "./KeyPrompt"
import { ListPicker, type ListEntry } from "./ListPicker"
import { autoDetect, C, I, iconSet, mdStyles, setIcons, setTheme, THEME_LABEL, themeName, type ThemeName } from "./theme"
import { getLang, setLang, t, type Lang } from "./i18n"

export const VERSION = "5.0.0-dev"

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
    fr ? "Réponds en français, clairement, en Markdown." : "Answer in English, clearly, in Markdown.",
    tools
      ? (fr ? `Tu as des outils pour lire, chercher, modifier les fichiers du projet et lancer des commandes. Lis avant de modifier ; préfère edit_file pour une petite modification. Permissions actuelles : ${perm}. Si une action est refusée, ne la contourne pas : explique et propose.`
            : `You have tools to read, search and change project files and run commands. Read before editing; prefer edit_file for small changes. Current permissions: ${perm}. If an action is refused, do not work around it: explain and propose.`)
      : (fr ? "Tu n'as pas d'outils avec ce modèle : tu ne peux ni lire ni modifier les fichiers toi-même ; dis-le si on te le demande."
            : "You have no tools with this model: you cannot read or change files yourself; say so if asked."),
    mode === "plan"
      ? (fr ? "Mode plan : lecture seule. Analyse et propose un plan, sans rien modifier." : "Plan mode: read-only. Analyse and propose a plan, without changing anything.")
      : "",
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
  const noTools = new Set<string>() // modèles qui ont refusé les outils (HTTP 400) : on n'en renvoie plus
  let abort: AbortController | null = null
  let history: Msg[] = []

  const prefs = () => st().prefs
  const updatePrefs = (p: Partial<State["prefs"]>) => {
    const next = { ...st(), prefs: { ...st().prefs, ...p } }
    setSt(next)
    save(next)
  }
  const mode = () => prefs().mode ?? "build"
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
    if (c.kind === "agent") return agentName(c.provider)
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
    if (!st().current) openModels() // premier lancement : aucun fournisseur n'est imposé
  })

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
    const tt = firstText.replace(/\s+/g, " ").slice(0, 60)
    conv = mem.newConversation(district(), tt)
    setTitle(tt)
    return conv
  }

  function newChat() {
    setItems([])
    history = []
    conv = null
    setTitle("")
  }

  function loadConversation(id: number) {
    const msgs = mem.messages(id)
    const row = mem.db.query("SELECT title, district_id FROM conversations WHERE id=?").get(id) as { title: string; district_id: number } | null
    batch(() => {
      newChat()
      conv = id
      setTitle(row?.title || `Session ${id}`)
      if (row) setDistrict(row.district_id)
      setItems(msgs.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as Item["role"], text: m.content, archiveId: m.id })))
    })
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
        if (!mi?.input?.includes("image")) {
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

  async function ask(text: string, opts: { aside?: boolean; readOnly?: boolean } = {}) {
    const c = current()
    if (!c) {
      note(t("Aucun modèle choisi : /models"), "warn")
      return openModels()
    }
    if (c.kind === "agent") {
      note(`La conversation avec ${agentName(c.provider)} n'est pas encore branchée dans cette version (agents CLI, prochaine étape). Choisissez un modèle d'API avec /models pour discuter dès maintenant.`, "warn")
      return
    }
    const p = provider(c.provider)!
    const mi = modelInfo(c)
    const blocked = budget.blocked(c.model!)
    if (blocked) return note(`Envoi bloqué : ${blocked}. /usage pour le détail, /define-token ou /limit pour changer.`, "error")
    const memCtx = mem.context(district(), text)
    const extra: Record<string, unknown> = { ...(prefs().options?.[effortKey(c)] ?? {}) }
    const lv = prefs().effort?.[effortKey(c)]
    const ev = lv ? levelValue(mi?.effort, lv) : undefined
    if (ev && mi?.effortParam) extra[mi.effortParam] = ev
    const useTools = mi?.tools !== false && !noTools.has(effortKey(c))
    const sys = systemPrompt(mode(), getLang(), cwd(), useTools, perms.mode) + (memCtx.text ? "\n\n" + memCtx.text : "")
    const uc = buildUserContent(text, mi)
    for (const n of uc.notes) note(n, n.includes("non envoyée") || n.includes("introuvable") || n.includes("trop gros") ? "warn" : "info")
    const msgs: Msg[] = [{ role: "system", content: sys }, ...history, { role: "user", content: uc.content as any }]
    if (!useTools && mi?.tools === false) note(`${c.model} n'accepte pas les outils : il répond sans pouvoir lire ni modifier les fichiers.`, "warn")

    setBusy(true)
    abort = new AbortController()
    const signal = abort.signal
    const env: ToolEnv = { roots: [cwd(), ...extraDirs()], perms, memory: mem, districtId: district(), todos: todoList, onTodos: syncTodos, signal }
    const saved = perms.mode
    if (opts.readOnly || mode() === "plan") perms.mode = "lecture"
    const snaps = useTools && !opts.aside ? new Snapshots(cwd()) : null
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
        for await (const e of streamChat(p, c.model!, msgs, { signal, extra, tools: useTools ? openAiTools() : undefined })) {
          if (e.type === "text") setItems(idx, "text", (x) => x + e.text)
          else if (e.type === "thinking") setItems(idx, "thinking", (x) => (x ?? "") + e.text)
          else if (e.type === "usage") {
            measured = true
            tin += e.input ?? 0
            tout += e.output ?? 0
          } else if (e.type === "tools") calls = e.calls
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
    if (tin || tout) budget.record({ session: sessionKey(), model: c.model!, tokensIn: tin, tokensOut: tout, measured, usd: estimateUsd(mi?.priceIn, mi?.priceOut, tin, tout), rate: rate(),
                                     note: `${c.provider}${opts.aside ? " · /btw" : ""}` })
    const u = usage[effortKey(c)] ?? { in: 0, out: 0, turns: 0 }
    batch(() => {
      setUsage(effortKey(c), { in: u.in + tin, out: u.out + tout, turns: u.turns + 1 })
      setItems(items.length, { role: "notice", text: `${mode() === "plan" || opts.readOnly ? "Plan" : "Build"} · ${c.model} · ${s.toFixed(1)} s` +
        (tout ? ` · ${Math.round(tout / Math.max(s, 0.1))} tok/s` : "") + ` · ↓${tin} ↑${tout} tok${measured ? "" : " (estimés)"}` +
        (interrupted ? ` · ${t("interrompu")}` : "") + (opts.aside ? " · à part, non gardé" : "") + (touched ? " · fichiers modifiés : /undo pour annuler" : ""), level: "info" })
      setBusy(false)
    })
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

  async function send(text: string) {
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
    const arg = rest.join(" ").trim()
    const c = resolve(name)
    if (!c) return note(`${t("Commande inconnue")} : /${name}  (/help)`, "error")
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
      case "model": {
        if (!arg) return openModels()
        const cur = current()
        const order = [...(cur?.kind === "api" ? [cur.provider] : []), ...PROVIDERS.map((p) => p.id)]
        for (const pid of order) if (status[pid]?.models?.some((m) => m.id === arg)) return pick({ kind: "api", provider: pid, model: arg })
        return note(`Modèle introuvable dans les catalogues chargés : ${arg}. Cherchez-le avec /models.`, "error")
      }
      case "effort": {
        const cur = current()
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
        newChat()
        return flash("Nouvelle discussion")
      case "sessions":
      case "open": {
        const all = c.name === "open"
        const list = mem.conversations(all ? undefined : district(), 200)
        if (!list.length) return note("Aucune session enregistrée pour ce projet. /open pour tous les projets.", "warn")
        return openList(all ? "Sessions et projets" : t("Sessions"), () => list.map((x) => ({
          title: x.title || `Session ${x.id}`, detail: `${x.count} échanges` + (all ? ` · ${x.district}` : ""),
          right: new Date(x.last * 1000).toLocaleString(getLang() === "fr" ? "fr-FR" : "en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
          value: String(x.id),
        })), (v) => { closeOverlay(); loadConversation(Number(v)) })
      }
      case "cd": {
        const target = resolvePath(cwd(), (arg || "~").replace(/^~/, home()))
        if (!existsSync(target) || !statSync(target).isDirectory()) return note(`Dossier introuvable : ${target}`, "error")
        setCwd(target)
        setDistrict(mem.district(target))
        newChat()
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
        updatePrefs({ sidebar: !prefs().sidebar })
        return flash(prefs().sidebar ? (dims().width >= 110 ? "Barre latérale affichée" : "Barre latérale activée (visible à partir de 110 colonnes)") : "Barre latérale masquée")
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
      case "details":
        setShowDetails((x) => !x)
        return flash(showDetails() ? "Détail des outils affiché" : "Détail des outils masqué (une ligne par outil)")
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
        mem.close()
        budget.close()
        return renderer.destroy()
    }
  }

  function submit() {
    const text = (prompt?.plainText ?? "").trim()
    if (!text) return
    if (busy()) return flash(t("Une réponse est en cours (échap pour interrompre)."))
    const sug = slashMatches()
    prompt?.clear()
    setDraft("")
    if (text.startsWith("/")) {
      const exact = resolve(text.slice(1).split(/\s/)[0])
      runCommand(exact || !sug.length ? text : "/" + sug[0].name) // « /mod » + Entrée : la commande proposée, comme dans OpenCode
    } else send(text)
  }

  const slashMatches = createMemo(() => {
    const d = draft()
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n")) return []
    return suggest(d.slice(1), 8)
  })

  useKeyboard((k) => {
    if (overlay()) return
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
    } else if (k.name === "escape" && abort) {
      abort.abort()
      const g = goal()
      if (g?.active) setGoal({ ...g, active: false })
    }
    else if (k.ctrl && k.name === "p") runCommand("/help")
    else if (k.ctrl && k.name === "t") runCommand("/effort")
    else if (k.name === "tab" && k.shift) runCommand("/mode " + (mode() === "build" ? "plan" : "build"))
    else if (k.name === "tab" && slashMatches().length) {
      prompt?.setText("/" + slashMatches()[0].name + " ")
      setDraft(prompt?.plainText ?? "")
    }
  })

  const PromptBox = () => (
    <box flexDirection="column" width="100%">
      <Show when={slashMatches().length}>
        <box flexDirection="column" border={["left"]} borderStyle="heavy" borderColor={C.panelBorder} paddingX={1} backgroundColor={C.panel}>
          <For each={slashMatches()}>
            {(c, i) => (
              <box flexDirection="row" height={1}>
                <text fg={i() === 0 ? C.accent : C.text} width={16}>{(i() === 0 ? "› /" : "  /") + c.name}</text>
                <text fg={c.ready ? C.muted : C.dim} flexGrow={1}>{c.desc.slice(0, Math.max(10, dims().width - 50)) + (c.ready ? "" : ` (${t("à venir")})`)}</text>
                <text fg={C.dim}>{c.keys ?? ""}</text>
              </box>
            )}
          </For>
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
          <text fg={C.muted}>{"  " + currentLabel()}</text>
          <Show when={permMode() !== "demander"}><text fg={permMode().startsWith("bypass") ? C.error : C.other}>{"  · " + permMode().toUpperCase()}</text></Show>
          <Show when={attachments().length}><text fg={C.recent}>{`  · ${attachments().length} pièce(s) jointe(s)`}</text></Show>
          <Show when={goal()?.active}><text fg={C.detected}>{"  · objectif en cours"}</text></Show>
          <Show when={busy()}><text fg={C.warn}>{"   " + t("en cours… échap pour interrompre")}</text></Show>
        </box>
      </box>
    </box>
  )

  const Footer = () => (
    <box flexDirection="row" justifyContent="space-between" height={1} width="100%" paddingX={1}>
      <text fg={C.dim}>{short(cwd())}</text>
      <text fg={toast() ? C.warn : leader() ? C.accent : C.dim}>
        {toast() || (leader() ? t("ctrl+x : m modèles · n nouvelle discussion · l sessions") : "maj+tab mode   " + t("ctrl+x m modèles   ctrl+p commandes   /help"))}
      </text>
    </box>
  )

  const Sidebar = () => {
    const its = () => mem.items(district()).slice(0, 5)
    const s = () => (conv ? budget.totals(0, { session: sessionKey() }) : null)
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
      </box>
    )
  }

  const Thread = () => (
    <box flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
      <text fg={C.text} height={1}><b>{(title() || items.find((i) => i.role === "user")?.text || "").split("\n")[0].slice(0, dims().width - 10)}</b></text>
      <scrollbox ref={(r: any) => (threadScroll = r)} flexGrow={1} stickyScroll stickyStart="bottom" marginTop={1}>
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
                  <Show when={it.level === "error"} fallback={<markdown content={it.text || (it.streaming ? "…" : "")} syntaxStyle={md()} streaming={!!it.streaming} />}>
                    <text fg={C.error}>{I.error + " " + it.text}</text>
                  </Show>
                  <Show when={it.meta}><text fg={C.dim} marginTop={1}>{it.meta}</text></Show>
                </box>
              </Show>
              <Show when={it.role === "tool"}>
                <box flexDirection="column" paddingX={3} border={["left"]} borderColor={it.running ? C.warn : it.ok ? C.ok : C.error} marginLeft={2}>
                  <text fg={C.muted}>{`${it.running ? I.recent : it.ok ? I.ok : I.error} ${it.tool}  ${(it.text ?? "").slice(0, dims().width - 30)}${it.running ? "  …" : ""}`}</text>
                  <Show when={showDetails() && !it.running && (it.diff || (!it.ok && it.output) || (it.tool === "run_command" && it.output))}>
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
              <Show when={prefs().sidebar && dims().width >= 110}><Sidebar /></Show>
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
