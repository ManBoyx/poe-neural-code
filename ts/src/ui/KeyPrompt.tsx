/** Saisie masquée d'une clé d'API : la clé n'est jamais affichée (seulement des points), ni gardée après l'envoi. */
import { createSignal } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import { C, I } from "./theme"

export function KeyPrompt(props: { label: string; note: string; onSubmit: (key: string) => void; onCancel: () => void; width: () => number }) {
  let key = ""
  const [len, setLen] = createSignal(0)
  const put = (s: string) => {
    key += s.replace(/[\r\n\t]/g, "")
    setLen(key.length)
  }
  useKeyboard((k) => {
    if (k.name === "escape") {
      key = ""
      props.onCancel()
    } else if (k.name === "return") {
      const v = key.trim()
      key = ""
      setLen(0)
      if (v) props.onSubmit(v)
    } else if (k.name === "backspace") {
      key = key.slice(0, -1)
      setLen(key.length)
    } else if (k.sequence && k.sequence.length === 1 && !k.ctrl && !k.meta && k.sequence >= " ") put(k.sequence)
  })
  usePaste((e: any) => put(String(e.text ?? "")))
  const w = () => Math.min(80, props.width() - 4)
  return (
    <box position="absolute" top={6} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} zIndex={20}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={C.accent} paddingX={2} paddingY={1} flexDirection="column">
      <text fg={C.text}><b>{I.api + "  Clé d'API " + props.label}</b></text>
      <text fg={C.muted} marginTop={1}>{props.note}</text>
      <box border borderStyle="rounded" borderColor={C.panelBorder} marginTop={1} paddingX={1} height={3}>
        <text fg={C.accent}>{len() ? "•".repeat(Math.min(len(), w() - 10)) : " "}</text>
      </box>
      <text fg={C.dim}>{len() ? `${len()} caractères · entrée enregistrer · échap annuler` : "collez ou tapez la clé · échap annuler"}</text>
    </box>
  )
}
