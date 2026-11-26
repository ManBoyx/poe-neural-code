/** Saisie d'une valeur visible sur une ligne (réglage d'un modèle, titre…). Pour une clé d'API : KeyPrompt (masquée). */
import { createSignal } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { C, I } from "./theme"
import { t } from "./i18n"

export function TextPrompt(props: { title: string; note?: string; initial?: string; onSubmit: (v: string) => void; onCancel: () => void; width: () => number }) {
  const [value, setValue] = createSignal(props.initial ?? "")
  useKeyboard((k) => {
    if (k.name === "escape") props.onCancel()
  })
  const w = () => Math.min(80, props.width() - 4)
  return (
    <box position="absolute" top={6} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} zIndex={20}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={C.accent} paddingX={2} paddingY={1} flexDirection="column">
      <text fg={C.text}><b>{I.model + "  " + props.title}</b></text>
      {props.note ? <text fg={C.muted} marginTop={1}>{props.note}</text> : null}
      <box border borderStyle="rounded" borderColor={C.panelBorder} marginTop={1} paddingX={1} height={3}>
        <input focused value={value()} onInput={setValue} onSubmit={(v: string) => props.onSubmit(v.trim())}
               textColor={C.text} backgroundColor={C.panel} focusedBackgroundColor={C.panel} />
      </box>
      <text fg={C.dim}>{"entrée valider · vide = défaut · " + t("échap")}</text>
    </box>
  )
}
