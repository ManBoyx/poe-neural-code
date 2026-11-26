/** Écran /cg : ligne du coordinateur, puis deux zones étiquetées (Claude Code, Codex) remplies en direct, sans mélange. */
import { For, Show } from "solid-js"
import type { CgAgent, CgStatus } from "../core/cg"
import { C, I } from "./theme"

export interface ZoneEntry {
  kind: "text" | "tool" | "thinking" | "error"
  text: string
  ok?: boolean
  running?: boolean
}

export interface Zone {
  status: CgStatus
  entries: ZoneEntry[]
  input: number
  output: number
  label: string // « Claude Code · sonnet · modifications »
}

const STATUS_COLOR = (s: CgStatus) => (s === "travaille" || s === "corrige" ? C.warn : s === "relit" || s === "coordonne" ? C.recent : s === "terminé" ? C.ok : s === "échec" ? C.error : C.dim)

function ZoneBox(props: { name: string; zone: Zone; width: number | `${number}%`; height?: number }) {
  return (
    <box flexDirection="column" width={props.width} height={props.height} flexGrow={props.height ? 0 : 1} border borderStyle="rounded"
         borderColor={props.zone.status === "travaille" || props.zone.status === "corrige" ? C.warn : C.panelBorder}
         title={` ${I.agent}  ${props.zone.label} `} titleColor={C.text} paddingX={1}>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={STATUS_COLOR(props.zone.status)}><b>{props.zone.status}</b></text>
        <text fg={C.dim}>{props.zone.input || props.zone.output ? `↓${props.zone.input} ↑${props.zone.output} tok` : ""}</text>
      </box>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <Show when={props.zone.entries.length} fallback={<text fg={C.dim}>{props.zone.status === "absent" ? "non installé : /cg continue avec l'autre agent" : " "}</text>}>
          <For each={props.zone.entries}>
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
      </scrollbox>
    </box>
  )
}

export function CgZones(props: { zones: Record<CgAgent, Zone>; phase: string; width: number; height: number }) {
  const wide = () => props.width >= 100
  // 45 % de la hauteur, sans jamais prendre la place de la saisie (≈ 13 lignes : titre, saisie, barre du bas, un peu de fil)
  const h = () => Math.max(4, Math.min(Math.floor(props.height * 0.45), props.height - 13))
  // hauteur fixe qui ne rétrécit pas : le fil des résultats et la zone de saisie restent en dessous, sans chevauchement
  return (
    <box flexDirection="column" width="100%" height={wide() ? h() + 1 : 2 * (Math.floor(h() / 2) + 2) + 1} flexShrink={0}>
      <text fg={C.accent} height={1}><b>{`${I.model}  ${props.phase || "Claude Code et Codex : décrivez votre demande"}`}</b></text>
      <Show when={wide()} fallback={
        <box flexDirection="column">
          <ZoneBox name="claude" zone={props.zones.claude} width="100%" height={Math.floor(h() / 2) + 2} />
          <ZoneBox name="codex" zone={props.zones.codex} width="100%" height={Math.floor(h() / 2) + 2} />
        </box>
      }>
        <box flexDirection="row" height={h()} gap={1}>
          <ZoneBox name="claude" zone={props.zones.claude} width="50%" />
          <ZoneBox name="codex" zone={props.zones.codex} width="50%" />
        </box>
      </Show>
    </box>
  )
}
