/** Demande d'autorisation d'un outil : ce qui va être fait (diff ou commande complète), puis une fois / session / refuser. */
import { createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { Decision, Request } from "../core/permissions"
import { C, I } from "./theme"

const CHOICES: { d: Decision; key: string; label: string }[] = [
  { d: "once", key: "o", label: "Autoriser une fois" },
  { d: "session", key: "t", label: "Toujours pour cette session" },
  { d: "deny", key: "r", label: "Refuser" },
]

export function PermissionPrompt(props: { req: Request; onDecide: (d: Decision) => void; width: () => number; height: () => number }) {
  let decided = false
  const decide = (d: Decision) => {
    if (decided) return
    decided = true
    setTimeout(() => props.onDecide(d), 0) // après la touche : elle ne se retrouve pas dans la saisie
  }
  const choices = () => (props.req.destructive || props.req.outside ? CHOICES.filter((c) => c.d !== "session") : CHOICES)
  const [sel, setSel] = createSignal(0)
  useKeyboard((k) => {
    k.preventDefault()
    k.stopPropagation()
    if (k.name === "escape") return decide("deny")
    if (k.name === "down" || k.name === "right" || k.name === "tab") setSel((s) => (s + 1) % choices().length)
    else if (k.name === "up" || k.name === "left") setSel((s) => (s + choices().length - 1) % choices().length)
    else if (k.name === "return") decide(choices()[sel()].d)
    else {
      const c = choices().find((x) => x.key === k.name || String(choices().indexOf(x) + 1) === k.name)
      if (c) decide(c.d)
    }
  })
  const w = () => Math.min(110, props.width() - 4)
  const lines = () => (props.req.detail ?? "").split("\n").slice(0, Math.max(3, props.height() - 16))
  const lineColor = (l: string) => (l.startsWith("+") && !l.startsWith("+++") ? C.ok : l.startsWith("-") && !l.startsWith("---") ? C.error : l.startsWith("@@") ? C.recent : C.muted)
  return (
    <box position="absolute" top={2} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} zIndex={30}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={props.req.destructive ? C.error : C.warn} paddingX={2} paddingY={1} flexDirection="column">
      <text fg={props.req.destructive ? C.error : C.warn}>
        <b>{`${I.warn}  Autoriser ${props.req.kind === "exec" ? "la commande" : props.req.kind === "write" ? "la modification" : "la lecture"} ?`}</b>
        {props.req.destructive ? "   ACTION DESTRUCTRICE" : ""}{props.req.outside ? "   HORS DU PROJET" : ""}
      </text>
      <text fg={C.text} marginTop={1}>{`${props.req.tool} · ${props.req.summary}`}</text>
      <Show when={props.req.detail && props.req.detail !== props.req.summary}>
        <box flexDirection="column" marginTop={1} border={["left"]} borderColor={C.panelBorder} paddingX={1}>
          <For each={lines()}>{(l) => <text fg={lineColor(l)}>{l.slice(0, w() - 8) || " "}</text>}</For>
          <Show when={(props.req.detail ?? "").split("\n").length > lines().length}><text fg={C.dim}>{`… ${(props.req.detail ?? "").split("\n").length - lines().length} lignes de plus`}</text></Show>
        </box>
      </Show>
      <box flexDirection="row" marginTop={1} gap={2}>
        <For each={choices()}>
          {(c, i) => <text fg={i() === sel() ? C.accent : C.muted}>{(i() === sel() ? "› " : "  ") + `${c.label} (${c.key})`}</text>}
        </For>
      </box>
      <text fg={C.dim}>{"← → choisir · entrée valider · o / t / r · échap refuse"}</text>
    </box>
  )
}
