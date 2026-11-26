/**
 * Menu de /cg : coordinateur, façon de travailler, relecture, sous-agents, puis modèle, effort et puissance de chaque
 * agent. ↑↓ choisir la ligne · ←→ (ou espace) changer la valeur · Entrée démarrer (ou appliquer) · échap fermer.
 * Chaque changement est enregistré tout de suite (réglages rechargés à la session suivante).
 */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { AgentModel } from "../core/agents"
import { CG_LABEL, CG_MODE_LABEL, type CgAgent, type CgMode } from "../core/cg"
import { C, I } from "./theme"

export interface CgSettings {
  lead: CgAgent
  mode: CgMode
  review: boolean
  subagents: boolean
  agents: Record<CgAgent, { model?: string; effort?: string; power?: "lecture" | "modifications" | "commandes" }>
}

interface Field {
  label: string
  values: { v: string; label: string }[]
  get: () => string
  set: (v: string) => void
  hint?: string
  disabled?: boolean
}

export function CgMenu(props: {
  settings: () => CgSettings
  update: (s: Partial<CgSettings>) => void
  setAgent: (a: CgAgent, s: { model?: string; effort?: string; power?: "lecture" | "modifications" | "commandes" }) => void
  models: () => Partial<Record<CgAgent, AgentModel[]>>
  installed: (a: CgAgent) => boolean
  active: boolean
  onStart: () => void
  onClose: () => void
  width: () => number
  height: () => number
}) {
  const [sel, setSel] = createSignal(0)
  const s = () => props.settings()
  const other = (a: CgAgent): CgAgent => (a === "claude" ? "codex" : "claude")

  const fields = createMemo<Field[]>(() => {
    const out: Field[] = [
      { label: "Coordinateur", values: (["claude", "codex"] as CgAgent[]).map((a) => ({ v: a, label: CG_LABEL[a] + (props.installed(a) ? "" : " (non installé)") })),
        get: () => s().lead, set: (v) => props.update({ lead: v as CgAgent }) },
      { label: "Façon de travailler", values: [
          { v: "auto", label: "Automatique" },
          { v: "seul", label: `${CG_LABEL[s().lead]} fait tout seul` },
          { v: "delegue", label: `${CG_LABEL[s().lead]} délègue à ${CG_LABEL[other(s().lead)]}` },
        ], get: () => s().mode, set: (v) => props.update({ mode: v as CgMode }), hint: CG_MODE_LABEL[s().mode] },
      { label: "Relecture par l'autre agent", values: [{ v: "oui", label: "oui" }, { v: "non", label: "non" }],
        get: () => (s().review ? "oui" : "non"), set: (v) => props.update({ review: v === "oui" }) },
      { label: "Sous-agents", values: [{ v: "oui", label: "autorisés" }, { v: "non", label: "interdits" }],
        get: () => (s().subagents ? "oui" : "non"), set: (v) => props.update({ subagents: v === "oui" }),
        hint: "chaque sous-agent apparaît comme un point de couleur dans la zone de son agent ; cliquez-le pour voir ce qu'il fait" },
    ]
    for (const a of ["claude", "codex"] as CgAgent[]) {
      const ms = props.models()[a] ?? []
      const cur = s().agents[a] ?? {}
      const efforts = ms.find((m) => m.id === cur.model)?.efforts ?? ms[0]?.efforts ?? []
      const dis = !props.installed(a)
      out.push(
        { label: `${CG_LABEL[a]} · modèle`, disabled: dis, values: [{ v: "", label: "défaut de l'agent" }, ...ms.map((m) => ({ v: m.id, label: m.id }))],
          get: () => cur.model ?? "", set: (v) => props.setAgent(a, { model: v || undefined }) },
        { label: `${CG_LABEL[a]} · effort`, disabled: dis, values: [{ v: "", label: "défaut" }, ...efforts.map((e) => ({ v: e, label: e }))],
          get: () => cur.effort ?? "", set: (v) => props.setAgent(a, { effort: v || undefined }) },
        { label: `${CG_LABEL[a]} · puissance`, disabled: dis, values: [{ v: "lecture", label: "lecture seule" }, { v: "modifications", label: "modifications" }, { v: "commandes", label: "modifications et commandes" }],
          get: () => cur.power ?? (a === "codex" ? "commandes" : "modifications"), set: (v) => props.setAgent(a, { power: v as any }) },
      )
    }
    return out
  })
  const count = () => fields().length + 1 // + « Démarrer »

  const cycle = (f: Field, dir: number) => {
    if (f.disabled || !f.values.length) return
    const i = Math.max(0, f.values.findIndex((x) => x.v === f.get()))
    f.set(f.values[(i + dir + f.values.length) % f.values.length].v)
  }

  useKeyboard((k) => {
    k.preventDefault()
    k.stopPropagation()
    if (k.name === "escape") return props.onClose()
    if (k.name === "down" || k.name === "tab") setSel((x) => (x + 1) % count())
    else if (k.name === "up") setSel((x) => (x - 1 + count()) % count())
    else if (k.name === "return") props.onStart() // Entrée valide le menu depuis n'importe quelle ligne
    else if ((k.name === "right" || k.name === "left" || k.name === "space") && sel() < fields().length) cycle(fields()[sel()], k.name === "left" ? -1 : 1)
  })

  const summary = () => {
    const st = s()
    const o = CG_LABEL[other(st.lead)]
    const l = CG_LABEL[st.lead]
    const what = st.mode === "seul" ? `${l} fait le travail lui-même` : st.mode === "delegue" ? `${l} prépare la consigne et ${o} fait le travail` : `${l} trie la demande et choisit qui écrit`
    return `${what}${st.review ? ", l'autre relit" : ", sans relecture"}${st.subagents ? " · sous-agents autorisés" : ""}.`
  }

  const w = () => Math.min(100, props.width() - 4)
  return (
    <box position="absolute" top={1} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} zIndex={20}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={C.accent} paddingX={2} paddingY={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={C.text}><b>{`${I.agent}  /cg — Claude Code et Codex`}</b></text>
        <text fg={C.dim}>échap</text>
      </box>
      <text fg={C.muted} marginTop={1}>{summary()}</text>
      <box flexDirection="column" marginTop={1}>
        <For each={fields()}>
          {(f, i) => (
            <box flexDirection="row" height={1} backgroundColor={i() === sel() ? C.selBg : undefined} paddingX={1}
                 onMouseDown={() => { setSel(i()); cycle(f, 1) }}>
              <text fg={f.disabled ? C.dim : i() === sel() ? C.accent : C.muted} width={32}>{(i() === sel() ? "› " : "  ") + f.label}</text>
              <text fg={f.disabled ? C.dim : C.text}>{(f.disabled ? "" : "‹ ") + (f.values.find((x) => x.v === f.get())?.label ?? f.get() ?? "—") + (f.disabled ? "  (agent non installé)" : " ›")}</text>
            </box>
          )}
        </For>
        <box flexDirection="row" height={1} marginTop={1} backgroundColor={sel() === fields().length ? C.selBg : undefined} paddingX={1} onMouseDown={() => props.onStart()}>
          <text fg={sel() === fields().length ? C.accent : C.ok}><b>{(sel() === fields().length ? "› " : "  ") + (props.active ? "Appliquer et continuer la discussion" : "Démarrer la discussion /cg")}</b></text>
        </box>
      </box>
      <Show when={fields()[sel()]?.hint}><text fg={C.dim} marginTop={1}>{fields()[sel()]?.hint}</text></Show>
      <text fg={C.dim} marginTop={1}>↑↓ ligne · ← → ou espace : valeur · clic · entrée : {props.active ? "appliquer" : "démarrer"} · échap</text>
    </box>
  )
}
