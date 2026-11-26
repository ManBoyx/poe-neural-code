/**
 * Écran /cg : ligne du coordinateur, puis deux zones étiquetées (Claude Code, Codex) remplies en direct, sans mélange.
 * Les sous-agents d'un agent apparaissent comme des points de couleur dans sa zone (● en cours, ○ terminé, × échec) :
 * un clic sur un point ouvre la vue du sous-agent (au clavier : /cg sous-agents).
 */
import { For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { CG_LABEL, type CgAgent, type CgStatus } from "../core/cg"
import { C, I } from "./theme"

export interface ZoneEntry {
  kind: "text" | "tool" | "thinking" | "error"
  text: string
  ok?: boolean
  running?: boolean
}

export interface SubAgent {
  id: string
  label: string
  color: string
  status: "travaille" | "terminé" | "échec"
  entries: ZoneEntry[]
  report?: string
}

export interface Zone {
  status: CgStatus
  entries: ZoneEntry[]
  input: number
  output: number
  label: string // « Claude Code · sonnet · modifications »
  subs: SubAgent[]
}

export const SUB_COLORS = ["#f472b6", "#60a5fa", "#facc15", "#34d399", "#fb923c", "#a78bfa", "#22d3ee", "#f87171"]
const subMark = (s: SubAgent) => (s.status === "travaille" ? "●" : s.status === "échec" ? "×" : "○")

const STATUS_COLOR = (s: CgStatus) => (s === "travaille" || s === "corrige" ? C.warn : s === "relit" || s === "coordonne" ? C.recent : s === "terminé" ? C.ok : s === "échec" ? C.error : C.dim)

function Entries(props: { entries: ZoneEntry[]; empty: string }) {
  return (
    <Show when={props.entries.length} fallback={<text fg={C.dim}>{props.empty}</text>}>
      <For each={props.entries}>
        {(e) => e.kind === "tool" ? (
          <text fg={e.running ? C.warn : e.ok === false ? C.error : C.muted}>{`${e.running ? I.recent : e.ok === false ? I.error : I.ok} ${e.text}`}</text>
        ) : e.kind === "error" ? (
          <text fg={C.error}>{I.error + " " + e.text}</text>
        ) : e.kind === "thinking" ? (
          <text fg={C.dim}>{`${I.think} ${e.text.slice(-300)}`}</text>
        ) : (
          <text fg={C.text}>{e.text}</text>
        )}
      </For>
    </Show>
  )
}

const ACTIVE = new Set(["travaille", "corrige", "relit", "coordonne"])

function ZoneBox(props: { agent: CgAgent; zone: Zone; width: number | `${number}%`; height?: number; tick?: string; onOpenSub: (a: CgAgent, id: string) => void }) {
  return (
    <box flexDirection="column" width={props.width} height={props.height} flexGrow={props.height ? 0 : 1} border borderStyle="rounded"
         borderColor={props.zone.status === "travaille" || props.zone.status === "corrige" ? C.warn : C.panelBorder}
         title={` ${I.agent}  ${props.zone.label} `} titleColor={C.text} paddingX={1}>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={STATUS_COLOR(props.zone.status)}><b>{(ACTIVE.has(props.zone.status) && props.tick ? props.tick + " " : "") + props.zone.status}</b></text>
        <text fg={C.dim}>{props.zone.input || props.zone.output ? `↓${props.zone.input} ↑${props.zone.output} tok` : ""}</text>
      </box>
      <Show when={props.zone.subs.length}>
        <box flexDirection="row" height={1} flexShrink={0}>
          <For each={props.zone.subs}>
            {(s) => <text fg={s.color} onMouseDown={() => props.onOpenSub(props.agent, s.id)}>{subMark(s) + " "}</text>}
          </For>
          <text fg={C.dim}>{` ${props.zone.subs.length} sous-agent(s) · clic sur un point`}</text>
        </box>
      </Show>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <Entries entries={props.zone.entries} empty={props.zone.status === "absent" ? "non installé : /cg continue avec l'autre agent" : " "} />
      </scrollbox>
    </box>
  )
}

export function cgTabs(zones: Record<CgAgent, Zone>): { id: string; label: string; color?: string }[] {
  return [
    { id: "ensemble", label: "Vue d'ensemble" },
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    ...(["claude", "codex"] as CgAgent[]).flatMap((a) => zones[a].subs.map((s) => ({ id: `sub:${a}:${s.id}`, label: `${subMark(s)} ${s.label.slice(0, 18)}`, color: s.color }))),
  ]
}

export function CgZones(props: { zones: Record<CgAgent, Zone>; phase: string; width: number; height: number; tick?: string; tab?: string; onTab?: (id: string) => void; onOpenSub: (a: CgAgent, id: string) => void }) {
  const wide = () => props.width >= 100
  // 45 % de la hauteur, sans jamais prendre la place de la saisie (≈ 13 lignes : titre, saisie, barre du bas, un peu de fil)
  const h = () => Math.max(4, Math.min(Math.floor(props.height * 0.45), props.height - 13))
  // hauteur fixe qui ne rétrécit pas : le fil des résultats et la zone de saisie restent en dessous, sans chevauchement
  return (
    <box flexDirection="column" width="100%" height={(wide() ? h() + 1 : 2 * (Math.floor(h() / 2) + 2) + 1) + 1} flexShrink={0}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <For each={cgTabs(props.zones)}>
          {(tb) => (
            <text fg={(props.tab ?? "ensemble") === tb.id ? C.accent : tb.color ?? C.muted} bg={(props.tab ?? "ensemble") === tb.id ? C.selBg : undefined}
                  onMouseDown={() => props.onTab?.(tb.id)}>{` ${(props.tab ?? "ensemble") === tb.id ? "▸ " : ""}${tb.label} `}</text>
          )}
        </For>
        <text fg={C.dim}>{"  alt+← → onglets"}</text>
      </box>
      <text fg={C.accent} height={1}><b>{`${props.tick && props.phase && !/approuvé|Désaccord|répondu|Réponse directe|verdict/i.test(props.phase) ? props.tick : I.model}  ${props.phase || "Claude Code et Codex : décrivez votre demande"}`}</b></text>
      <Show when={(props.tab ?? "ensemble") === "ensemble"} fallback={<TabBody zones={props.zones} tab={props.tab!} height={wide() ? h() : 2 * (Math.floor(h() / 2) + 2)} tick={props.tick} onOpenSub={props.onOpenSub} />}>
      <Show when={wide()} fallback={
        <box flexDirection="column">
          <ZoneBox agent="claude" zone={props.zones.claude} width="100%" height={Math.floor(h() / 2) + 2} tick={props.tick} onOpenSub={props.onOpenSub} />
          <ZoneBox agent="codex" zone={props.zones.codex} width="100%" height={Math.floor(h() / 2) + 2} tick={props.tick} onOpenSub={props.onOpenSub} />
        </box>
      }>
        <box flexDirection="row" height={h()} gap={1}>
          <ZoneBox agent="claude" zone={props.zones.claude} width="50%" tick={props.tick} onOpenSub={props.onOpenSub} />
          <ZoneBox agent="codex" zone={props.zones.codex} width="50%" tick={props.tick} onOpenSub={props.onOpenSub} />
        </box>
      </Show>
      </Show>
    </box>
  )
}

/** Contenu d'un onglet : un agent en pleine largeur, ou un sous-agent. */
function TabBody(props: { zones: Record<CgAgent, Zone>; tab: string; height: number; tick?: string; onOpenSub: (a: CgAgent, id: string) => void }) {
  if (props.tab === "claude" || props.tab === "codex")
    return <ZoneBox agent={props.tab} zone={props.zones[props.tab]} width="100%" height={props.height} tick={props.tick} onOpenSub={props.onOpenSub} />
  const [, a, id] = props.tab.split(":")
  const s = () => props.zones[a as CgAgent]?.subs.find((x) => x.id === id)
  return (
    <box flexDirection="column" height={props.height} border borderStyle="rounded" borderColor={s()?.color ?? C.panelBorder} paddingX={1}
         title={` ${s() ? subMark(s()!) : ""} ${s()?.label ?? "sous-agent"} · sous-agent de ${CG_LABEL[a as CgAgent] ?? a} `} titleColor={s()?.color ?? C.text}>
      <text fg={s()?.status === "travaille" ? C.warn : s()?.status === "échec" ? C.error : C.ok}>{(s()?.status === "travaille" && props.tick ? props.tick + " " : "") + (s()?.status ?? "terminé")}</text>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <Entries entries={s()?.entries ?? []} empty="rien encore" />
        <Show when={s()?.report}>
          <text fg={C.accent} marginTop={1}><b>Rapport rendu à l'agent</b></text>
          <text fg={C.text}>{s()!.report}</text>
        </Show>
      </scrollbox>
    </box>
  )
}

/** Vue d'un sous-agent : ce qu'il fait, en direct. ← → passent au sous-agent voisin ; échap ferme. */
export function SubAgentView(props: { agent: CgAgent; zone: Zone; id: string; onMove: (id: string) => void; onClose: () => void; width: () => number; height: () => number }) {
  const sub = () => props.zone.subs.find((s) => s.id === props.id)
  useKeyboard((k) => {
    k.preventDefault()
    k.stopPropagation()
    if (k.name === "escape") return props.onClose()
    const i = props.zone.subs.findIndex((s) => s.id === props.id)
    if ((k.name === "right" || k.name === "left") && props.zone.subs.length > 1) {
      const n = (i + (k.name === "right" ? 1 : -1) + props.zone.subs.length) % props.zone.subs.length
      props.onMove(props.zone.subs[n].id)
    }
  })
  const w = () => Math.min(110, props.width() - 4)
  return (
    <box position="absolute" top={1} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} height={props.height() - 2} zIndex={25}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={sub()?.color ?? C.accent} paddingX={2} paddingY={1} flexDirection="column">
      <Show when={sub()} fallback={<text fg={C.dim}>sous-agent introuvable</text>}>
        <box flexDirection="row" justifyContent="space-between" height={1}>
          <text fg={sub()!.color}><b>{`${subMark(sub()!)}  ${sub()!.label}`}</b></text>
          <text fg={C.dim}>{`sous-agent de ${CG_LABEL[props.agent]} · ${props.zone.subs.findIndex((s) => s.id === props.id) + 1}/${props.zone.subs.length} · ← → · échap`}</text>
        </box>
        <text fg={sub()!.status === "travaille" ? C.warn : sub()!.status === "échec" ? C.error : C.ok} marginTop={1}>{sub()!.status}</text>
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" marginTop={1}>
          <Entries entries={sub()!.entries} empty="rien encore" />
          <Show when={sub()!.report}>
            <text fg={C.accent} marginTop={1}><b>Rapport rendu à l'agent</b></text>
            <text fg={C.text}>{sub()!.report}</text>
          </Show>
        </scrollbox>
      </Show>
    </box>
  )
}
