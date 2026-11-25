/** Interface d'Eclipse, disposition façon OpenCode : accueil centré, fil de discussion, zone de saisie, barre du bas. */
import { batch, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { detect, type Detected } from "../core/detect"
import { catalog, keyFor, provider, PROVIDERS, verifyKey } from "../core/providers"
import { setKey } from "../core/secrets"
import { streamChat, type Msg } from "../core/chat"
import { choose, load, save, type Choice, type State } from "../core/store"
import { short } from "../core/paths"
import { Picker, type ProviderStatus } from "./Picker"
import { KeyPrompt } from "./KeyPrompt"
import { C, I, MD_STYLES } from "./theme"

export const VERSION = "5.0.0-dev"

interface Item {
  role: "user" | "assistant" | "notice"
  text: string
  thinking?: string
  meta?: string
  level?: "info" | "warn" | "error"
  streaming?: boolean
}

const COMMANDS: { name: string; desc: string; keys?: string }[] = [
  { name: "models", desc: "Choisir le modèle", keys: "ctrl+x m" },
  { name: "connect", desc: "Connexions : saisir ou changer une clé d'API" },
  { name: "provider", desc: "Choisir le fournisseur ou l'agent" },
  { name: "new", desc: "Nouvelle discussion", keys: "ctrl+x n" },
  { name: "help", desc: "Aide et raccourcis" },
  { name: "exit", desc: "Quitter Eclipse", keys: "ctrl+c ×2" },
]

const LOGO = [
  "█▀▀▀ █▀▀█ █    ▀█▀ █▀▀█ █▀▀▀ █▀▀▀",
  "█▀▀▀ █    █     █  █▀▀▀ ▀▀▀█ █▀▀▀",
  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀ ▀    ▀▀▀▀ ▀▀▀▀",
]

export function App(props: { cwd: string }) {
  const renderer = useRenderer()
  const dims = useTerminalDimensions()
  const md = SyntaxStyle.fromStyles(MD_STYLES as any, renderer.nativeScene as any)

  const [st, setSt] = createSignal<State>(load())
  const [detected, setDetected] = createSignal<Detected[]>([])
  const [status, setStatus] = createStore<Record<string, ProviderStatus>>({})
  const [items, setItems] = createStore<Item[]>([])
  const [overlay, setOverlay] = createSignal<null | "picker" | { key: string }>(null)
  const [busy, setBusy] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [leader, setLeader] = createSignal(false)
  const [exitArmed, setExitArmed] = createSignal(0)
  const [toast, setToast] = createSignal("")
  let prompt: TextareaRenderable | undefined
  let abort: AbortController | null = null
  const history: Msg[] = []

  const flash = (t: string) => {
    setToast(t)
    setTimeout(() => setToast((x) => (x === t ? "" : x)), 3000)
  }

  // ouverture au tour suivant : la touche qui ouvre la fenêtre (Entrée, « m ») n'y est pas reçue une seconde fois
  const openPicker = () => setTimeout(() => setOverlay("picker"), 0)

  const current = () => st().current
  const currentLabel = createMemo(() => {
    const c = current()
    if (!c) return "aucun modèle — /models"
    if (c.kind === "agent") return detected().find((d) => d.id === c.provider)?.label ?? c.provider
    return `${c.model} · ${provider(c.provider)?.label ?? c.provider}`
  })

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
      if (key === "invalid") {
        needKey(id)
        return
      }
    }
    if (key !== "ok" && key !== "local") return
    const r = await catalog(p, { refresh })
    setStatus(id, r.ok ? { key, keyNote, models: r.models, loading: false, error: undefined } : { key, keyNote, loading: false, error: r.reason })
  }

  /** Repropose /connect pour ce fournisseur : clé absente, supprimée ou modifiée. Seulement s'il est utilisé ou recommandé. */
  function needKey(id: string, force = false) {
    const c = st().current
    if (!force && !(c?.kind === "api" && c.provider === id) && !provider(id)?.recommended) return
    if (overlay() && typeof overlay() === "object") return
    setTimeout(() => setOverlay({ key: id }), 0)
  }

  onMount(async () => {
    // tout se charge en arrière-plan : l'écran s'affiche tout de suite
    for (const p of PROVIDERS) if (p.recommended || p.local) loadProvider(p.id)
    for (const p of PROVIDERS) if (!p.recommended && !p.local) {
      keyFor(p).then((k) => {
        if (k.ok) loadProvider(p.id)
        else setStatus(p.id, { key: k.missing ? "missing" : "error", keyNote: k.missing ? "clé à saisir" : k.reason })
      })
    }
    detect({ withVersion: true, manual: st().agentPaths }).then(setDetected)
    if (!st().current) setOverlay("picker") // premier lancement : aucun fournisseur n'est imposé
  })

  function pick(c: Choice) {
    const next = choose(st(), c)
    setSt(next)
    save(next)
    setOverlay(null)
    flash(`Modèle → ${c.model ?? detected().find((d) => d.id === c.provider)?.label ?? c.provider}`)
    prompt?.focus()
  }

  function note(text: string, level: Item["level"] = "info") {
    setItems(items.length, { role: "notice", text, level })
  }

  async function send(text: string) {
    const c = current()
    setItems(items.length, { role: "user", text })
    if (!c) {
      note("Aucun modèle choisi : /models", "warn")
      openPicker()
      return
    }
    if (c.kind === "agent") {
      note(`La conversation avec ${currentLabel()} n'est pas encore branchée dans cette version (étape 5 du plan). Choisissez un modèle d'API avec /models pour discuter dès maintenant.`, "warn")
      return
    }
    const p = provider(c.provider)!
    history.push({ role: "user", content: text })
    const idx = items.length
    setItems(idx, { role: "assistant", text: "", streaming: true })
    setBusy(true)
    abort = new AbortController()
    const t0 = Date.now()
    let out = 0
    for await (const e of streamChat(p, c.model!, history, { signal: abort.signal })) {
      if (e.type === "text") setItems(idx, "text", (t) => t + e.text)
      else if (e.type === "thinking") setItems(idx, "thinking", (t) => (t ?? "") + e.text)
      else if (e.type === "usage") out = e.output ?? out
      else if (e.type === "error") {
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
    batch(() => {
      setItems(idx, "streaming", false)
      setItems(idx, "meta", `${c.model} · ${s.toFixed(1)} s` + (out ? ` · ${Math.round(out / s)} tok/s` : "") + (interrupted ? " · interrompu" : ""))
      setBusy(false)
    })
    if (items[idx].text && items[idx].level !== "error") history.push({ role: "assistant", content: items[idx].text })
  }

  function runCommand(raw: string) {
    const [cmd] = raw.slice(1).trim().split(/\s+/)
    if (cmd === "connect") {
      const c = current()
      const s = c?.kind === "api" ? status[c.provider] : undefined
      if (c?.kind === "api" && s && s.key !== "ok" && s.key !== "local") needKey(c.provider, true)
      else openPicker()
    } else if (cmd === "models" || cmd === "provider" || cmd === "model") openPicker()
    else if (cmd === "new" || cmd === "clear") {
      setItems([])
      history.length = 0
    } else if (cmd === "exit" || cmd === "quit") renderer.destroy()
    else if (cmd === "help") note(COMMANDS.map((c) => `/${c.name}  ${c.desc}${c.keys ? "  (" + c.keys + ")" : ""}`).join("\n"))
    else note(`Commande inconnue : /${cmd}`, "error")
  }

  function submit() {
    const text = (prompt?.plainText ?? "").trim()
    if (!text) return
    if (busy()) {
      flash("Une réponse est en cours (échap pour interrompre).")
      return
    }
    const sug = slashMatches()
    prompt?.clear()
    setDraft("")
    // « /mod » + Entrée : la commande proposée est lancée, comme dans OpenCode
    if (text.startsWith("/") && sug.length && !COMMANDS.some((c) => c.name === text.slice(1).split(/\s/)[0])) runCommand("/" + sug[0].name)
    else if (text.startsWith("/")) runCommand(text)
    else send(text)
  }

  const slashMatches = createMemo(() => {
    const d = draft()
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n")) return []
    return COMMANDS.filter((c) => c.name.startsWith(d.slice(1)))
  })

  useKeyboard((k) => {
    if (overlay()) return
    if (leader()) {
      setLeader(false)
      if (k.name === "m") openPicker()
      else if (k.name === "n") runCommand("/new")
      return
    }
    if (k.ctrl && k.name === "x") setLeader(true)
    else if (k.ctrl && k.name === "c") {
      if (prompt?.plainText) {
        prompt.clear()
        setDraft("")
      } else if (Date.now() - exitArmed() < 2000) renderer.destroy()
      else {
        setExitArmed(Date.now())
        flash("Ctrl+C encore une fois pour quitter.")
      }
    } else if (k.name === "escape" && abort) abort.abort()
    else if (k.ctrl && k.name === "p") note(COMMANDS.map((c) => `/${c.name}  ${c.desc}`).join("\n"))
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
            {(c) => (
              <box flexDirection="row" height={1}>
                <text fg={C.accent} width={14}>{"/" + c.name}</text>
                <text fg={C.muted} flexGrow={1}>{c.desc}</text>
                <text fg={C.dim}>{c.keys ?? ""}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <box flexDirection="column" border={["left"]} borderStyle="heavy" borderColor={busy() ? C.warn : C.accent} paddingX={2} paddingY={1} backgroundColor={C.panel}>
        <textarea ref={(r: TextareaRenderable) => (prompt = r)} focused={!overlay()} minHeight={1} maxHeight={8}
                  placeholder={items.length ? "Votre message…" : "Demandez n'importe quoi…  « Corrige un TODO du projet »"} placeholderColor={C.dim}
                  textColor={C.text} backgroundColor={C.panel} focusedBackgroundColor={C.panel} wrapMode="word"
                  keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" },
                                { name: "j", ctrl: true, action: "newline" }, { name: "return", meta: true, action: "newline" }]}
                  onSubmit={submit} onContentChange={() => setDraft(prompt?.plainText ?? "")} />
        <box flexDirection="row" marginTop={1} height={1}>
          <text fg={C.accent}><b>Build</b></text>
          <text fg={C.muted}>{"  " + currentLabel()}</text>
          <Show when={busy()}><text fg={C.warn}>{"   en cours… échap pour interrompre"}</text></Show>
        </box>
      </box>
    </box>
  )

  const Footer = () => (
    <box flexDirection="row" justifyContent="space-between" height={1} width="100%" paddingX={1}>
      <text fg={C.dim}>{short(props.cwd)}</text>
      <text fg={toast() ? C.warn : leader() ? C.accent : C.dim}>
        {toast() || (leader() ? "ctrl+x : m modèles · n nouvelle discussion" : "ctrl+x m modèles   ctrl+p commandes   /help")}
      </text>
    </box>
  )

  return (
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
        <box flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
          <text fg={C.text} height={1}><b>{(items.find((i) => i.role === "user")?.text ?? "").split("\n")[0].slice(0, dims().width - 10)}</b></text>
          <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" marginTop={1}>
            <For each={items}>
              {(it) => (
                <box flexDirection="column" marginBottom={1}>
                  <Show when={it.role === "user"}>
                    <box border={["left"]} borderStyle="heavy" borderColor={C.userBar} paddingX={2} paddingY={1} backgroundColor={C.panel}>
                      <text fg={C.text}>{it.text}</text>
                    </box>
                  </Show>
                  <Show when={it.role === "assistant"}>
                    <box flexDirection="column" paddingX={3}>
                      <Show when={it.thinking}><text fg={C.dim}>{`${I.think} Réflexion · ${it.thinking!.length} caractères`}</text></Show>
                      <Show when={it.level === "error"} fallback={<markdown content={it.text || (it.streaming ? "…" : "")} syntaxStyle={md} streaming={!!it.streaming} />}>
                        <text fg={C.error}>{I.error + " " + it.text}</text>
                      </Show>
                      <Show when={it.meta}><text fg={C.dim} marginTop={1}>{"Build · " + it.meta}</text></Show>
                    </box>
                  </Show>
                  <Show when={it.role === "notice"}>
                    <box paddingX={3}><text fg={it.level === "error" ? C.error : it.level === "warn" ? C.warn : C.muted}>{it.text}</text></box>
                  </Show>
                </box>
              )}
            </For>
          </scrollbox>
          <PromptBox />
        </box>
      </Show>
      <Footer />
      <Show when={overlay() === "picker"}>
        <Picker state={st} detected={detected} status={() => status} width={() => dims().width} height={() => dims().height}
                onChoose={pick} onClose={() => { setOverlay(null); prompt?.focus() }}
                onOpenProvider={(id) => loadProvider(id)}
                onNeedKey={(id) => setOverlay({ key: id })} />
      </Show>
      <Show when={typeof overlay() === "object" && overlay() !== null ? (overlay() as { key: string }) : null}>
        {(o) => (
          <KeyPrompt label={provider(o().key)?.label ?? o().key} width={() => dims().width}
                     note={(status[o().key]?.key === "invalid" ? `${status[o().key]!.keyNote}. Saisissez la nouvelle clé. ` : "") + `Vérifiée puis stockée dans le trousseau du système, jamais affichée ni écrite en clair.`}
                     onCancel={() => setOverlay("picker")}
                     onSubmit={async (key) => {
                       const id = o().key
                       const pv = provider(id)!
                       flash("Vérification de la clé…")
                       const v = await verifyKey(pv, { key })
                       if (v.check === "refusée") {
                         flash(`${pv.label} refuse cette clé : vérifiez-la et recommencez.`)
                         return
                       }
                       const r = await setKey(id, key)
                       flash(r.ok ? (v.check === "valide" ? "Clé acceptée et enregistrée dans le trousseau" : `Clé enregistrée (${v.detail})`) : r.message)
                       if (!r.ok) return
                       setOverlay(null)
                       const c = current()
                       if (c?.kind === "api" && c.provider === id) prompt?.focus()
                       else openPicker()
                       loadProvider(id, true)
                     }} />
        )}
      </Show>
    </box>
  )
}
