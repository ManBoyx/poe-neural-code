/** Saisie masquée d'une clé d'API : la clé n'est jamais affichée (seulement des points), ni gardée après l'envoi. */
import { createSignal, Show } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import { C, I } from "./theme"
import { t } from "./i18n"

export function KeyPrompt(props: { label: string; note: string; onSubmit: (key: string) => void; onCancel: () => void; width: () => number }) {
  let key = ""
  const [len, setLen] = createSignal(0)
  const [hint, setHint] = createSignal("")
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
    } else if (k.ctrl && k.name === "v") {
      // Alacritty (et la plupart des terminaux Linux) collent avec Ctrl+Maj+V ; Ctrl+V seul n'envoie aucun texte
      setHint(t("Ctrl+V ne colle pas dans ce terminal : utilisez Ctrl+Maj+V."))
    } else if (k.sequence && k.sequence.length === 1 && !k.ctrl && !k.meta && k.sequence >= " ") put(k.sequence)
  })
  // un collage arrive en octets (PasteEvent.bytes) : décodés en texte, sans jamais être affichés
  const dec = new TextDecoder()
  usePaste((e) => {
    e.preventDefault()
    put(dec.decode(e.bytes).trim())
  })
  const w = () => Math.min(80, props.width() - 4)
  return (
    <box position="absolute" top={6} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} zIndex={20}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={C.accent} paddingX={2} paddingY={1} flexDirection="column">
      <text fg={C.text}><b>{I.api + "  " + t("Clé d'API") + " " + props.label}</b></text>
      <text fg={C.muted} marginTop={1}>{props.note}</text>
      <box border borderStyle="rounded" borderColor={C.panelBorder} marginTop={1} paddingX={1} height={3}>
        <text fg={C.accent}>{len() ? "•".repeat(Math.min(len(), w() - 10)) : " "}</text>
      </box>
      <Show when={hint()}><text fg={C.warn}>{hint()}</text></Show>
      <text fg={C.dim}>{len() ? `${len()} ${t("caractères · entrée enregistrer · échap annuler")}` : t("collez (ctrl+maj+v) ou tapez la clé · échap annuler")}</text>
    </box>
  )
}
