/** Liste à choisir, avec filtre (sessions, commandes, thèmes, langue). Même allure que la fenêtre des modèles. */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { C, I } from "./theme"
import { t } from "./i18n"

export interface ListEntry {
  title: string
  detail?: string
  right?: string
  header?: boolean
  dim?: boolean
  value?: string
}

export function ListPicker(props: { title: string; entries: () => ListEntry[]; onPick: (value: string) => void; onClose: () => void; width: () => number; height: () => number; hint?: string }) {
  const [query, setQuery] = createSignal("")
  const [sel, setSel] = createSignal(0)
  const rows = createMemo(() => {
    const q = query().trim().toLowerCase()
    const all = props.entries()
    if (!q) return all
    return all.filter((e) => !e.header && (e.title + " " + (e.detail ?? "") + " " + (e.right ?? "")).toLowerCase().includes(q))
  })
  const selectable = createMemo(() => rows().map((r, i) => (!r.header && !r.dim && r.value !== undefined ? i : -1)).filter((i) => i >= 0))
  const current = () => selectable()[Math.min(sel(), Math.max(0, selectable().length - 1))] ?? -1
  useKeyboard((k) => {
    if (k.name === "escape") props.onClose()
    else if (k.name === "down") setSel((s) => Math.min(s + 1, selectable().length - 1))
    else if (k.name === "up") setSel((s) => Math.max(0, s - 1))
    else if (k.name === "pagedown") setSel((s) => Math.min(s + 10, selectable().length - 1))
    else if (k.name === "pageup") setSel((s) => Math.max(0, s - 10))
    else if (k.name === "return") {
      const r = rows()[current()]
      if (r?.value !== undefined) props.onPick(r.value)
    }
  })
  const visible = () => Math.max(5, props.height() - 11 - Math.max(0, rows().filter((r: any) => r.kind === "header" || r.header).length - 1))
  const start = createMemo(() => Math.max(0, Math.min(current() - Math.floor(visible() / 2), rows().length - visible())))
  const w = () => Math.min(100, props.width() - 4)
  return (
    <box position="absolute" top={2} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} height={props.height() - 4} zIndex={10}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={C.panelBorder} paddingX={2} paddingY={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={C.text}><b>{props.title}</b></text>
        <text fg={C.dim}>{t("échap")}</text>
      </box>
      <box flexDirection="row" height={1} marginTop={1}>
        <text fg={C.accent}>{I.search + " "}</text>
        <input flexGrow={1} focused placeholder="Filtrer…" placeholderColor={C.dim} textColor={C.text} backgroundColor={C.panel} focusedBackgroundColor={C.panel}
               value={query()} onInput={(v: string) => { setQuery(v); setSel(0) }} />
      </box>
      <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        <For each={rows().slice(start(), start() + visible())}>
          {(r, i) => r.header ? (
            <box height={1} marginTop={i() === 0 ? 0 : 1}><text fg={C.accent}><b>{r.title}</b></text></box>
          ) : (
            <box height={1} flexDirection="row" paddingX={1} backgroundColor={start() + i() === current() ? C.selBg : undefined}>
              <text fg={r.dim ? C.dim : start() + i() === current() ? C.accent : C.text} width={30}>{(start() + i() === current() ? "› " : "  ") + r.title.slice(0, 27)}</text>
              <text fg={C.muted} flexGrow={1}>{(r.detail ?? "").slice(0, Math.max(0, w() - 8 - 30 - (r.right ? Math.min(r.right.length, 26) + 2 : 0)))}</text>
              <Show when={r.right}><text fg={C.dim}>{"  " + (r.right ?? "").slice(-26)}</text></Show>
            </box>
          )}
        </For>
      </box>
      <text fg={C.dim}>{props.hint ?? "↑↓ · entrée · tapez pour filtrer · échap"}</text>
    </box>
  )
}
