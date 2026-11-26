/**
 * Demande d'autorisation d'un outil : ce qui va être fait (diff ou commande complète), puis une fois / session / refuser.
 * Le détail n'est jamais tronqué : les lignes longues sont repliées et ↑ ↓ (pg préc. / pg suiv.) font défiler.
 * Avec `mustRead`, « Autoriser » n'est possible qu'une fois tout le détail affiché.
 */
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { Decision, Request } from "../core/permissions"
import { C, I } from "./theme"

/** Largeur d'affichage d'un caractère (2 pour les idéogrammes et la plupart des emoji, 0 pour les combinants). */
const charWidth = (ch: string) => Math.max(0, Bun.stringWidth(ch))

/** Replie une ligne pour qu'aucun morceau ne dépasse `cols` colonnes d'écran (suite indentée de 2). */
export function wrapToWidth(line: string, cols: number): string[] {
  const out: string[] = []
  let cur = ""
  let wcur = 0
  for (const ch of line) {
    const cw = charWidth(ch)
    // coupe dès que la ligne est pleine, même si elle n'est faite que d'espaces (seule la marge de suite est exclue)
    if (wcur + cw > cols && wcur > (out.length ? 2 : 0)) {
      out.push(cur)
      cur = "  "
      wcur = 2
    }
    cur += ch
    wcur += cw
  }
  out.push(cur)
  return out
}

/** Rend visibles les caractères invisibles ou trompeurs (contrôle, sens d'écriture, largeur nulle) : \u{…}. */
export const revealHidden = (s: string) =>
  s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === "\n" ? c : `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`))
    // longues suites d'espaces (ordinaires ou non) après le retrait de début de ligne : affichées en clair, elles ne
    // peuvent pas repousser un argument hors de la vue (le retrait de l'indentation JSON reste tel quel)
    .split("\n").map((l) => {
      const lead = /^ */.exec(l)![0]
      return lead + l.slice(lead.length).replace(/[\p{Zs}]{4,}/gu, (m) => `{${m.length} espaces}`)
    }).join("\n")

/** Résumé sur une seule ligne d'écran (le détail complet, lui, n'est jamais coupé). */
const oneLine = (s: string, cols: number) => {
  const flat = s.replace(/\n/g, " ⏎ ")
  const parts = wrapToWidth(flat, Math.max(10, cols - 1))
  return parts.length > 1 ? parts[0] + "…" : flat
}

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
  const [off, setOff] = createSignal(0)
  const w = () => Math.min(110, props.width() - 4)
  // lignes repliées à la largeur de la fenêtre : rien n'est coupé
  // largeur intérieure réelle (bords, marges, filet), en colonnes d'écran : aucune ligne n'est repliée une 2e fois
  const wrapped = () => (props.req.detail ?? "").split("\n").flatMap((l) => wrapToWidth(l, Math.max(20, w() - 13)))
  const page = () => Math.max(1, props.height() - 16)
  // fenêtre trop petite pour montrer le détail sans le replier une 2e fois ni le couper : rien ne peut être autorisé
  const tooSmall = () => props.height() - 16 < Math.min(3, wrapped().length) || w() - 13 < 20
  const maxOff = () => Math.max(0, wrapped().length - page())
  const lines = () => wrapped().slice(off(), off() + page())
  const allSeen = createSignal(false)
  const seen = () => allSeen[0]() || off() >= maxOff()
  const scroll = (d: number) => {
    setOff((o) => Math.min(maxOff(), Math.max(0, o + d)))
    if (off() >= maxOff()) allSeen[1](true)
  }
  // taille de la fenêtre changée : les coupures changent, la lecture reprend du début (et « Autoriser » se reverrouille)
  createEffect(on(() => [w(), page()], () => { setOff(0); allSeen[1](false) }, { defer: true }))
  const blocked = (d: Decision) => d !== "deny" && !!props.req.mustRead && (tooSmall() || !seen())
  const tryDecide = (d: Decision) => (blocked(d) ? (tooSmall() ? undefined : scroll(page())) : decide(d))
  useKeyboard((k) => {
    k.preventDefault()
    k.stopPropagation()
    if (k.name === "escape") return decide("deny")
    if (k.name === "right" || k.name === "tab") setSel((s) => (s + 1) % choices().length)
    else if (k.name === "left") setSel((s) => (s + choices().length - 1) % choices().length)
    else if (k.name === "down") scroll(1)
    else if (k.name === "up") scroll(-1)
    else if (k.name === "pagedown" || k.name === "space") scroll(page())
    else if (k.name === "pageup") scroll(-page())
    else if (k.name === "return") tryDecide(choices()[sel()].d)
    else {
      const c = choices().find((x) => x.key === k.name || String(choices().indexOf(x) + 1) === k.name)
      if (c) tryDecide(c.d)
    }
  })
  const lineColor = (l: string) => (l.startsWith("+") && !l.startsWith("+++") ? C.ok : l.startsWith("-") && !l.startsWith("---") ? C.error : l.startsWith("@@") ? C.recent : C.muted)
  return (
    <box position="absolute" top={2} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} zIndex={30}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={props.req.destructive ? C.error : C.warn} paddingX={2} paddingY={1} flexDirection="column">
      <text fg={props.req.destructive ? C.error : C.warn}>
        <b>{`${I.warn}  ${props.req.tool === "mcp" ? "Lancer ce programme fourni par le projet ?" : `Autoriser ${props.req.kind === "exec" ? "la commande" : props.req.kind === "write" ? "la modification" : "la lecture"} ?`}`}</b>
        {props.req.destructive && props.req.tool !== "mcp" ? "   ACTION DESTRUCTRICE" : ""}{props.req.outside ? "   HORS DU PROJET" : ""}
      </text>
      <text fg={C.text} marginTop={1}>{oneLine(`${props.req.tool} · ${revealHidden(props.req.summary)}`, w() - 8)}</text>
      <Show when={props.req.detail && props.req.detail !== props.req.summary}>
        <box flexDirection="column" marginTop={1} border={["left"]} borderColor={C.panelBorder} paddingX={1}>
          <For each={lines()}>{(l) => <text fg={lineColor(l)}>{l || " "}</text>}</For>
          <Show when={props.req.mustRead && tooSmall()}>
            <text fg={C.warn}>{"Fenêtre trop petite pour tout afficher : agrandissez le terminal pour pouvoir autoriser."}</text>
          </Show>
          <Show when={maxOff() > 0}>
            <text fg={props.req.mustRead && !seen() ? C.warn : C.dim}>{`lignes ${off() + 1}–${Math.min(wrapped().length, off() + page())} sur ${wrapped().length} · ↑ ↓ ou espace pour faire défiler${props.req.mustRead && !seen() ? " · lisez jusqu'au bout pour pouvoir autoriser" : ""}`}</text>
          </Show>
        </box>
      </Show>
      <box flexDirection="row" marginTop={1} gap={2}>
        <For each={choices()}>
          {(c, i) => <text fg={blocked(c.d) ? C.dim : i() === sel() ? C.accent : C.muted}>{(i() === sel() ? "› " : "  ") + `${c.label} (${c.key})`}</text>}
        </For>
      </box>
      <text fg={C.dim}>{"← → choisir · entrée valider · o / t / r · ↑ ↓ faire défiler · échap refuse"}</text>
    </box>
  )
}
