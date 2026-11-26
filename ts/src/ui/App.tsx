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
import { coerce } from "../core/providers"
import { VERSION_INFO } from "../core/version"
import { Picker, type ProviderStatus } from "./Picker"
import { KeyPrompt } from "./KeyPrompt"
import { ListPicker, type ListEntry } from "./ListPicker"
import { autoDetect, C, I, iconSet, mdStyles, setIcons, setTheme, THEME_LABEL, themeName, type ThemeName } from "./theme"
import { getLang, setLang, t, type Lang } from "./i18n"

export const VERSION = "5.0.0-dev"

interface Item {
  role: "user" | "assistant" | "notice"
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

function systemPrompt(mode: "build" | "plan", lang: Lang, cwd: string): string {
  const fr = lang === "fr"
  return [
    fr ? "Tu es Eclipse, un assistant de programmation dans un terminal." : "You are Eclipse, a programming assistant in a terminal.",
    fr ? `Dossier de travail : ${cwd}.` : `Working folder: ${cwd}.`,
    fr ? "Réponds en français, clairement, en Markdown." : "Answer in English, clearly, in Markdown.",
    mode === "plan"
      ? (fr ? "Mode plan : analyse et propose un plan, sans écrire de modifications complètes." : "Plan mode: analyse and propose a plan, without writing full changes.")
      : (fr ? "Tu n'as pas encore d'outils dans cette version : tu ne peux ni lire ni modifier les fichiers toi-même ; dis-le si on te le demande."
            : "You have no tools yet in this version: you cannot read or change files yourself; say so if asked."),
  ].join("\n")
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

  async function ask(text: string, opts: { aside?: boolean } = {}) {
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
    const sys = systemPrompt(mode(), getLang(), cwd()) + (memCtx.text ? "\n\n" + memCtx.text : "")
    const msgs: Msg[] = [{ role: "system", content: sys }, ...history, { role: "user", content: text }]
    const idx = items.length
    setItems(idx, { role: "assistant", text: "", streaming: true, aside: opts.aside,
                    memory: memCtx.used.length ? `${I.memory} ${t("Mémoire")} : ${memCtx.used.length} ${t("éléments utilisés")}` : undefined })
    setBusy(true)
    abort = new AbortController()
    const t0 = Date.now()
    let out = 0
    let inTok = 0
    for await (const e of streamChat(p, c.model!, msgs, { signal: abort.signal, extra })) {
      if (e.type === "text") setItems(idx, "text", (x) => x + e.text)
      else if (e.type === "thinking") setItems(idx, "thinking", (x) => (x ?? "") + e.text)
      else if (e.type === "usage") {
        out = e.output ?? out
        inTok = e.input ?? inTok
      } else if (e.type === "error") {
        setItems(idx, produce((it) => { it.level = "error"; it.text = (it.text ? it.text + "\n\n" : "") + e.message }))
        if (/HTTP 40[13]/.test(e.message)) {
          setStatus(c.provider, { key: "invalid", keyNote: `${p.label} refuse la clé : supprimée ou modifiée`, models: status[c.provider]?.models })
          needKey(c.provider, true)
        }
      }
    }
    const interrupted = abort.signal.aborted
    abort = null
    const s = (Date.now() - t0) / 1000
    const u = usage[effortKey(c)] ?? { in: 0, out: 0, turns: 0 }
    if (inTok || out || items[idx].text) {
      const measured = !!(inTok || out)
      const tin = measured ? inTok : estimateTokens(msgs.map((m) => m.content).join("\n"))
      const tout = measured ? out : estimateTokens(items[idx].text)
      budget.record({ session: sessionKey(), model: c.model!, tokensIn: tin, tokensOut: tout, measured, usd: estimateUsd(mi?.priceIn, mi?.priceOut, tin, tout), rate: rate(),
                      note: `${c.provider}${opts.aside ? " · /btw" : ""}` })
    }
    batch(() => {
      setUsage(effortKey(c), { in: u.in + inTok, out: u.out + out, turns: u.turns + 1 })
      setItems(idx, "streaming", false)
      setItems(idx, "meta", `${mode() === "plan" ? "Plan" : "Build"} · ${c.model} · ${s.toFixed(1)} s` + (out ? ` · ${Math.round(out / Math.max(s, 0.1))} tok/s` : "") +
                            (inTok || out ? ` · ↓${inTok} ↑${out} tok` : "") + (interrupted ? ` · ${t("interrompu")}` : "") + (opts.aside ? " · à part, non gardé" : ""))
      setBusy(false)
    })
    const answer = items[idx].text
    if (opts.aside || !answer || items[idx].level === "error") return
    history.push({ role: "user", content: text }, { role: "assistant", content: answer })
    const aid = mem.append(ensureConv(text), "assistant", answer, { provider: c.provider, model: c.model, interrupted })
    setItems(idx, "archiveId", aid)
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
        const hist = history.reduce((n, m) => n + estimateTokens(m.content), 0)
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
    } else if (k.name === "escape" && abort) abort.abort()
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
