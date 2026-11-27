/**
 * Choix du fournisseur et du modèle (/provider, /models, Ctrl+X M, premier lancement).
 * Ordre : barre « Rechercher d'autres modèles », récemment utilisés, API recommandées, détectés sur cet ordinateur.
 * La recherche parcourt tous les catalogues chargés, les fournisseurs et les agents.
 */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { Detected } from "../core/detect"
import { CATEGORY_LABEL, CATEGORY_ORDER, modelCategory, PROVIDERS, type ModelCategory, type ModelInfo } from "../core/providers"
import type { Choice, State } from "../core/store"
import { C, I } from "./theme"
import { short } from "../core/paths"
import { t } from "./i18n"

export interface ProviderStatus {
  key: "ok" | "missing" | "invalid" | "error" | "local"
  keyNote: string
  models?: ModelInfo[]
  error?: string
  loading?: boolean
}

type Row =
  | { kind: "header"; label: string; color: string; icon: string }
  | { kind: "item"; title: string; detail: string; right?: string; color: string; dim?: boolean; run: () => void }

const CAT_COLOR: Record<ModelCategory, string> = { multi: C.accent, code: C.detected, recherche: C.recent, texte: C.api, image: C.other, video: C.other, audio: C.other }
const CAT_ICON: Record<ModelCategory, string> = { multi: I.multi, code: I.code, recherche: I.search, texte: I.model, image: I.image, video: I.video, audio: I.music }

export interface PickerProps {
  state: () => State
  detected: () => Detected[]
  status: () => Record<string, ProviderStatus>
  onChoose: (c: Choice) => void
  onNeedKey: (providerId: string) => void
  onOpenProvider: (providerId: string) => void
  onClose: () => void
  initialView?: string
  width: () => number
  height: () => number
}

function ago(ts: number): string {
  if (!ts) return t("ancienne version")
  const s = (Date.now() - ts) / 1000
  if (s < 3600) return `il y a ${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`
  if (s < 172800) return t("hier")
  return new Date(ts).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })
}

function label(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id
}

export function modelDetail(m: ModelInfo): string {
  const parts: string[] = []
  const media = (m.output ?? []).filter((o) => o !== "text")
  if (media.length && !(m.output ?? []).includes("text")) parts.push(media.map((o) => (o === "image" ? "image" : o === "video" ? "vidéo" : o === "audio" ? "son" : o)).join(" + "))
  if (m.context && m.context >= 1000) parts.push(`${Math.round(m.context / 1000)}k`)
  if (m.free) parts.push("gratuit")
  else if (m.priceIn != null && m.priceOut != null) parts.push(`$${m.priceIn.toFixed(2)}/$${m.priceOut.toFixed(2)} par Mtok`)
  if (m.tools === false) parts.push("sans outils")
  if (m.effort?.length) parts.push("effort " + m.effort.join("/"))
  return parts.join(" · ")
}

export function Picker(props: PickerProps) {
  const [query, setQuery] = createSignal("")
  const [view, setView] = createSignal<string | null>(props.initialView ?? null) // null = accueil ; sinon id du fournisseur affiché
  const [sel, setSel] = createSignal(0)

  const open = (id: string) => {
    props.onOpenProvider(id)
    setView(id)
    setQuery("")
    setSel(0)
  }

  const agentLabel = (id: string) => props.detected().find((d) => d.id === id)?.label ?? id

  const rows = createMemo<Row[]>(() => {
    const q = query().trim().toLowerCase()
    const st = props.status()
    const out: Row[] = []
    const v = view()
    if (v) {
      const s = st[v]
      out.push({ kind: "header", label: `MODÈLES ${label(v).toUpperCase()}`, color: C.api, icon: I.model })
      if (s?.key === "invalid" || s?.key === "missing") {
        out.push({ kind: "item", title: s.key === "invalid" ? "Clé refusée" : "Aucune clé", detail: `${s.keyNote} — entrée : /connect, saisir la clé`, color: C.warn, run: () => props.onNeedKey(v) })
        return out
      }
      if (!s || s.loading) out.push({ kind: "item", title: "Chargement du catalogue…", detail: "", color: C.muted, dim: true, run: () => {} })
      else if (s.error && s.key === "local") out.push({ kind: "item", title: `${label(v)} ${s.error}`, detail: "lancez-le, puis rouvrez cette liste", color: C.warn, dim: true, run: () => {} })
      else if (s.error) out.push({ kind: "item", title: s.error, detail: "entrée : saisir ou changer la clé", color: C.warn, run: () => props.onNeedKey(v) })
      else {
        const ms = (s.models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || CATEGORY_LABEL[modelCategory(m)].toLowerCase().includes(q))
        // rangés par catégorie : code avec code, images avec images… ; les multifonctions ensemble
        for (const cat of CATEGORY_ORDER) {
          const g = ms.filter((m) => modelCategory(m) === cat)
          if (!g.length) continue
          out.push({ kind: "header", label: `${CATEGORY_LABEL[cat].toUpperCase()} · ${g.length}`, color: CAT_COLOR[cat], icon: CAT_ICON[cat] })
          for (const m of g) out.push({ kind: "item", title: m.id, detail: modelDetail(m), color: C.text, run: () => props.onChoose({ kind: "api", provider: v, model: m.id }) })
        }
        const raw = query().trim()
        if (v === "poe" && /^[\w.-]{2,60}$/.test(raw) && !ms.some((m) => m.id.toLowerCase() === q))
          out.push({ kind: "item", title: `Utiliser le bot Poe « ${raw} »`, detail: "n'importe quel bot public de poe.com, par son nom", color: C.api, run: () => props.onChoose({ kind: "api", provider: "poe", model: raw }) })
        else if (!ms.length) out.push({ kind: "item", title: "Aucun modèle ne correspond", detail: "", color: C.muted, dim: true, run: () => {} })
      }
      return out
    }
    if (q) {
      // recherche partout : fournisseurs, agents, modèles des catalogues chargés
      out.push({ kind: "header", label: t("RÉSULTATS"), color: C.recent, icon: I.search })
      for (const p of PROVIDERS) if (p.label.toLowerCase().includes(q) || p.id.includes(q))
        out.push({ kind: "item", title: p.label, detail: st[p.id]?.keyNote ?? "", right: "fournisseur", color: C.api, run: () => open(p.id) })
      for (const d of props.detected()) if (d.label.toLowerCase().includes(q))
        out.push({ kind: "item", title: d.label, detail: d.installed ? d.version ?? d.path ?? "" : "non installé — " + d.install, right: "agent", color: C.detected, dim: !d.installed,
                   run: () => d.installed && props.onChoose({ kind: "agent", provider: d.id }) })
      let n = 0
      for (const p of PROVIDERS) for (const m of st[p.id]?.models ?? []) {
        if (n >= 400 || !(m.id.toLowerCase().includes(q) || CATEGORY_LABEL[modelCategory(m)].toLowerCase().includes(q))) continue
        n++
        out.push({ kind: "item", title: m.id, detail: modelDetail(m), right: `${p.label} · ${CATEGORY_LABEL[modelCategory(m)].split(" (")[0]}`, color: C.text, run: () => props.onChoose({ kind: "api", provider: p.id, model: m.id }) })
      }
      const missing = PROVIDERS.filter((p) => !p.local && st[p.id]?.key === "missing").map((p) => p.label)
      // tout bot public de poe.com s'appelle par son nom, même s'il n'est pas dans le catalogue de l'API
      const raw = query().trim()
      const exact = (st.poe?.models ?? []).some((m) => m.id.toLowerCase() === q)
      if (st.poe?.key === "ok" && /^[\w.-]{2,60}$/.test(raw) && !exact)
        out.push({ kind: "item", title: `Utiliser le bot Poe « ${raw} »`, detail: "n'importe quel bot public de poe.com, par son nom", right: "Poe", color: C.api, run: () => props.onChoose({ kind: "api", provider: "poe", model: raw }) })
      if (missing.length) out.push({ kind: "item", title: `Sans clé, non cherchés : ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`, detail: "", color: C.dim, dim: true, run: () => {} })
      if (out.length === 1) out.push({ kind: "item", title: "Aucun résultat", detail: "", color: C.muted, dim: true, run: () => {} })
      return out
    }
    const recents = props.state().recents
    if (recents.length) {
      out.push({ kind: "header", label: t("RÉCEMMENT UTILISÉS"), color: C.recent, icon: I.recent })
      for (const r of recents)
        out.push({ kind: "item", title: r.model ?? agentLabel(r.provider), detail: r.kind === "agent" ? "agent installé" : label(r.provider), right: ago(r.at), color: C.text,
                   run: () => props.onChoose({ kind: r.kind, provider: r.provider, model: r.model }) })
    }
    out.push({ kind: "header", label: t("API RECOMMANDÉES"), color: C.api, icon: I.api })
    for (const p of PROVIDERS.filter((x) => x.recommended)) {
      const s = st[p.id]
      const bad = s?.key === "invalid" || s?.key === "missing"
      const detail = s ? (s.key === "ok" ? `${I.ok} ${s.keyNote}` + (s.models ? ` · ${s.models.length} modèles` : s.loading ? " · catalogue…" : "")
                          : `${bad ? I.warn + " " : ""}${s.keyNote}${bad ? " — entrée : saisir la clé" : ""}`) : "…"
      out.push({ kind: "item", title: p.label, detail, color: bad ? C.warn : C.text, run: () => (bad ? props.onNeedKey(p.id) : open(p.id)) })
    }
    out.push({ kind: "header", label: t("DÉTECTÉS SUR CET ORDINATEUR"), color: C.detected, icon: I.detected })
    const inst = props.detected().filter((d) => d.installed)
    for (const d of inst)
      out.push({ kind: "item", title: d.label, detail: d.version ?? d.versionError ?? "", right: short(d.path ?? ""), color: C.text, run: () => props.onChoose({ kind: "agent", provider: d.id }) })
    for (const p of PROVIDERS.filter((x) => x.local)) {
      const s = st[p.id]
      if (s?.models) out.push({ kind: "item", title: p.label, detail: `en marche · ${s.models.length} modèle(s)`, right: p.baseUrl, color: C.text, run: () => open(p.id) })
    }
    if (!inst.length && !PROVIDERS.some((p) => p.local && st[p.id]?.models))
      out.push({ kind: "item", title: props.detected().length ? "Aucun agent ni serveur local trouvé" : "Détection en cours…", detail: "", color: C.muted, dim: true, run: () => {} })
    return out
  })

  const selectable = createMemo(() => rows().map((r, i) => (r.kind === "item" && !r.dim ? i : -1)).filter((i) => i >= 0))
  const current = () => selectable()[Math.min(sel(), Math.max(0, selectable().length - 1))] ?? -1

  useKeyboard((k) => {
    // seules les touches gérées ici sont consommées : les lettres vont au champ de recherche
    if (["escape", "return", "up", "down", "pageup", "pagedown"].includes(k.name)) {
      k.preventDefault()
      k.stopPropagation()
    }
    if (k.name === "escape") {
      if (view()) {
        setView(null)
        setQuery("")
        setSel(0)
      } else props.onClose()
    } else if (k.name === "down" || (k.ctrl && k.name === "n")) setSel((s) => Math.min(s + 1, selectable().length - 1))
    else if (k.name === "up" || (k.ctrl && k.name === "p")) setSel((s) => Math.max(s - 1, 0))
    else if (k.name === "pagedown") setSel((s) => Math.min(s + 10, selectable().length - 1))
    else if (k.name === "pageup") setSel((s) => Math.max(s - 10, 0))
    else if (k.name === "return") {
      const r = rows()[current()]
      if (r?.kind === "item") r.run()
    }
  })

  // la fenêtre montre une tranche de la liste autour de la sélection
  const visible = () => Math.max(5, props.height() - 11 - Math.max(0, rows().filter((r: any) => r.kind === "header" || r.header).length - 1))
  const start = createMemo(() => {
    const c = current()
    return Math.max(0, Math.min(c - Math.floor(visible() / 2), rows().length - visible()))
  })
  const w = () => Math.min(100, props.width() - 4)

  return (
    <box position="absolute" top={2} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} height={props.height() - 4} zIndex={10}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={C.panelBorder} paddingX={2} paddingY={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={C.text}><b>{view() ? label(view()!) : t("Choisir un modèle")}</b></text>
        <text fg={C.dim}>{view() ? t("échap retour") : t("échap")}</text>
      </box>
      <box flexDirection="row" height={1} marginTop={1}>
        <text fg={C.accent}>{I.search + " "}</text>
        <input flexGrow={1} focused placeholder={view() ? t("Filtrer les modèles…") : t("Rechercher d'autres modèles…")} placeholderColor={C.dim}
               textColor={C.text} backgroundColor={C.panel} focusedBackgroundColor={C.panel} value={query()}
               onInput={(v: string) => { setQuery(v); setSel(0) }} />
      </box>
      <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        <For each={rows().slice(start(), start() + visible())}>
          {(r, i) =>
            r.kind === "header" ? (
              <box height={1} marginTop={i() === 0 ? 0 : 1}><text fg={r.color}><b>{r.icon + "  " + r.label}</b></text></box>
            ) : (
              <box height={1} flexDirection="row" backgroundColor={start() + i() === current() ? C.selBg : undefined} paddingX={1}>
                <text fg={r.dim ? C.dim : start() + i() === current() ? C.accent : r.color} width={r.detail || r.right ? 34 : undefined} flexGrow={r.detail || r.right ? 0 : 1}>
                  {(start() + i() === current() ? "› " : "  ") + (r.detail || r.right ? r.title.slice(0, 31) : r.title.slice(0, w() - 10))}
                </text>
                <text fg={C.muted} flexGrow={1}>{r.detail.slice(0, Math.max(0, w() - 8 - 34 - (r.right ? Math.min(r.right.length, 30) + 2 : 0)))}</text>
                <Show when={r.right}><text fg={C.dim}>{"  " + (r.right ?? "").slice(-30)}</text></Show>
              </box>
            )
          }
        </For>
      </box>
      <text fg={C.dim}>{t("↑↓ choisir · entrée valider · tapez pour rechercher partout")}</text>
    </box>
  )
}
