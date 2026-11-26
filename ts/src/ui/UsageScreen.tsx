/**
 * /usage : écran de consommation (et non un message dans la discussion). Cadres séparés, barres avec leur pourcentage
 * écrit (le sens ne repose jamais sur la couleur seule), nature de chaque valeur : mesuré, estimé, saisi.
 * Tab change la période du détail par modèle ; ↑↓ et PgPréc/PgSuiv font défiler ; échap ferme.
 */
import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { Budget, dayStart, monthStart, tokens, weekStart, type Totals } from "../core/budget"
import { poeBalance } from "../core/providers"
import { C, I } from "./theme"
import { t } from "./i18n"

const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR").replace(/ /g, " ")
const usd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

export function bar(frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, frac || 0))
  const n = Math.round(f * width)
  return "█".repeat(n) + "░".repeat(width - n)
}

const SPARK = "▁▂▃▄▅▆▇█"
export function spark(values: number[]): string {
  const max = Math.max(...values, 0)
  return values.map((v) => (v <= 0 ? "·" : SPARK[Math.min(7, Math.floor((v / max) * 7.999))])).join("")
}

export interface UsageProps {
  budget: Budget
  session: string | null
  current: { label: string; provider?: string; model?: string; priceIn?: number; priceOut?: number; billing: string }
  rate: number | null
  onClose: () => void
  width: () => number
  height: () => number
}

const PERIODS = [
  { id: "mois", label: "ce mois", since: () => monthStart() },
  { id: "semaine", label: "cette semaine", since: () => weekStart() },
  { id: "jour", label: "aujourd'hui", since: () => dayStart() },
  { id: "tout", label: "depuis le début", since: () => 0 },
] as const

export function UsageScreen(props: UsageProps) {
  const [period, setPeriod] = createSignal(0)
  const [balance, setBalance] = createSignal<string>("lecture du solde…")
  let scroll: ScrollBoxRenderable | undefined

  onMount(async () => {
    if (props.current.provider !== "poe") return setBalance("")
    const b = await poeBalance()
    setBalance(b.ok ? `${fmt(b.points)} points · ${usd(b.usd)}` + (b.nextGrant ? ` · prochain crédit quotidien ${new Date(b.nextGrant * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "")
                       : b.reason)
  })

  useKeyboard((k) => {
    k.preventDefault()
    k.stopPropagation()
    if (k.name === "escape" || (k.name === "q" && !k.ctrl)) props.onClose()
    else if (k.name === "tab") setPeriod((p) => (p + (k.shift ? PERIODS.length - 1 : 1)) % PERIODS.length)
    else if (k.name === "down") scroll?.scrollBy(1)
    else if (k.name === "up") scroll?.scrollBy(-1)
    else if (k.name === "pagedown") scroll?.scrollBy(Math.max(1, props.height() - 8))
    else if (k.name === "pageup") scroll?.scrollBy(-Math.max(1, props.height() - 8))
  })

  const w = () => Math.min(110, props.width() - 4)
  const barW = () => Math.max(10, Math.min(30, w() - 70))

  const session = createMemo<Totals | null>(() => (props.session ? props.budget.totals(0, { session: props.session }) : null))
  const periods = createMemo(() => PERIODS.map((p) => ({ ...p, t: props.budget.totals(p.since()) })))
  const days = createMemo(() => props.budget.daily(30))
  const models = createMemo(() => props.budget.byModel(PERIODS[period()].since()))
  const envs = createMemo(() => props.budget.envelopes().map((e) => props.budget.status(e)))

  const Section = (p: { title: string; icon: string; color: string; children: JSX.Element; right?: string }) => (
    <box flexDirection="column" border borderStyle="rounded" borderColor={C.panelBorder} paddingX={2} marginBottom={1} title={` ${p.icon}  ${p.title} `} titleColor={p.color}>
      <Show when={p.right}><text fg={C.dim}>{p.right}</text></Show>
      {p.children}
    </box>
  )
  const Row = (p: { label: string; value: string; note?: string; color?: string }) => (
    <box flexDirection="row" height={1}>
      <text fg={C.muted} width={18}>{p.label}</text>
      <text fg={p.color ?? C.text} flexGrow={1}>{p.value}</text>
      <Show when={p.note}><text fg={C.dim}>{"  " + p.note}</text></Show>
    </box>
  )
  const tokLine = (x: Totals) => {
    const m = x.tokensIn.measured + x.tokensOut.measured
    const e = x.tokensIn.estimated + x.tokensOut.estimated
    return `↓ ${fmt(x.tokensIn.measured + x.tokensIn.estimated)}  ↑ ${fmt(x.tokensOut.measured + x.tokensOut.estimated)}  tokens` +
           (m && e ? `  (${fmt(m)} mesurés, ${fmt(e)} estimés)` : m ? "  (mesurés)" : e ? "  (estimés)" : "")
  }
  const pts = (x: Totals) => {
    const parts = [["measured", "mesuré"], ["estimated", "estimé"], ["manual", "saisi"]].filter(([k]) => (x.points as any)[k]).map(([k, fr]) => `${fmt((x.points as any)[k])} pts (${fr})`)
    return parts.join(" + ")
  }
  const maxPeriod = createMemo(() => Math.max(1, ...periods().map((p) => tokens(p.t))))
  const maxModel = createMemo(() => Math.max(1, ...models().map((m) => tokens(m))))

  return (
    <box position="absolute" top={1} left={Math.max(0, Math.floor((props.width() - w()) / 2))} width={w()} height={props.height() - 2} zIndex={10}
         backgroundColor={C.panel} border borderStyle="rounded" borderColor={C.panelBorder} paddingX={2} paddingY={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={C.text}><b>{I.model + "  Consommation"}</b></text>
        <text fg={C.dim}>{"tab période · ↑↓ défiler · " + t("échap")}</text>
      </box>
      <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} flexGrow={1} marginTop={1}>
        <Section title="Fournisseur actuel" icon={I.api} color={C.api}>
          <Row label="Fournisseur" value={props.current.label} />
          <Row label="Facturation" value={props.current.billing} />
          <Show when={props.current.priceIn != null}>
            <Row label="Prix catalogue" value={`$${props.current.priceIn!.toFixed(2)} entrée · $${props.current.priceOut!.toFixed(2)} sortie, par million de tokens`} />
          </Show>
          <Show when={balance()}>
            <Row label="Solde Poe" value={balance()} note={balance().includes("points") ? "mesuré par Poe" : undefined} color={balance().includes("points") ? C.ok : C.warn} />
          </Show>
          <Show when={props.current.provider === "poe"}>
            <Row label="Taux points/$" value={props.rate ? `${props.rate} (saisi)` : "non saisi : /rate N pour estimer les points"} color={props.rate ? C.text : C.dim} />
          </Show>
        </Section>

        <Section title="Cette session" icon={I.recent} color={C.recent}>
          <Show when={session() && session()!.requests} fallback={<text fg={C.dim}>aucune réponse dans cette session</text>}>
            <Row label="Réponses" value={String(session()!.requests)} />
            <Row label="Tokens" value={tokLine(session()!)} />
            <Row label="Coût" value={session()!.usd ? `≈ ${usd(session()!.usd)}` : "—"} note={session()!.usd ? "estimé (prix × tokens)" : undefined} />
            <Show when={pts(session()!)}><Row label="Points" value={pts(session()!)} /></Show>
          </Show>
        </Section>

        <Section title="Par période" icon={I.model} color={C.accent} right="tokens comptés par Eclipse (pas l'historique complet du compte)">
          <For each={periods()}>
            {(p) => (
              <box flexDirection="row" height={1}>
                <text fg={C.muted} width={18}>{p.label}</text>
                <text fg={C.accent} width={barW() + 1}>{bar(tokens(p.t) / maxPeriod(), barW())}</text>
                <text fg={C.text} width={14}>{fmt(tokens(p.t)) + " tok"}</text>
                <text fg={C.muted} width={13}>{p.t.requests + " réponses"}</text>
                <text fg={C.dim} flexGrow={1}>{(p.t.usd ? "≈ " + usd(p.t.usd) : "") + (pts(p.t) ? "  " + pts(p.t) : "")}</text>
              </box>
            )}
          </For>
        </Section>

        <Section title="Activité sur 30 jours" icon={I.recent} color={C.recent}>
          <text fg={C.recent}>{spark(days().map((d) => d.tokens))}</text>
          <box flexDirection="row" justifyContent="space-between" width={30}>
            <text fg={C.dim}>{new Date(days()[0].day * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}</text>
            <text fg={C.dim}>aujourd'hui</text>
          </box>
          <text fg={C.muted}>{(() => {
            const act = days().filter((d) => d.requests)
            const best = days().reduce((a, b) => (b.tokens > a.tokens ? b : a), days()[0])
            return `${act.length} jour(s) d'activité · ${fmt(days().reduce((n, d) => n + d.requests, 0))} réponses` +
                   (best.tokens ? ` · record ${fmt(best.tokens)} tok le ${new Date(best.day * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}` : "")
          })()}</text>
        </Section>

        <Section title={`Par modèle et agent — ${PERIODS[period()].label}`} icon={I.agent} color={C.detected} right="tab : changer de période">
          <Show when={models().length} fallback={<text fg={C.dim}>rien sur cette période</text>}>
            <For each={models().slice(0, 15)}>
              {(m) => (
                <box flexDirection="row" height={1}>
                  <text fg={C.text} width={26}>{m.model.slice(0, 25)}</text>
                  <text fg={C.detected} width={barW() + 1}>{bar(tokens(m) / maxModel(), barW())}</text>
                  <text fg={C.muted} width={6}>{Math.round((tokens(m) / Math.max(1, models().reduce((n, x) => n + tokens(x), 0))) * 100) + " %"}</text>
                  <text fg={C.text} width={14}>{fmt(tokens(m)) + " tok"}</text>
                  <text fg={C.dim} flexGrow={1}>{m.requests + " rép." + (m.usd ? " · ≈ " + usd(m.usd) : "")}</text>
                </box>
              )}
            </For>
          </Show>
        </Section>

        <Section title="Budgets et limites" icon={I.warn} color={C.other}>
          <Show when={envs().length} fallback={<text fg={C.dim}>aucun budget actif · /define-token pour un budget en points ou tokens · /limit N [5h] pour une limite</text>}>
            <For each={envs()}>
              {(s) => {
                const e = s.envelope
                const fp = e.amountPoints ? s.spentPoints / e.amountPoints : null
                const ft = e.tokenLimit ? s.spentTokens / e.tokenLimit : null
                return (
                  <box flexDirection="column" marginBottom={1}>
                    <text fg={C.text}><b>{`${e.name} (${e.kind})`}</b>{e.periodEnd ? `  · renouvelé le ${new Date(e.periodEnd * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}{e.onExhaust === "pause" ? "  · bloque à 100 %" : "  · avertit seulement"}</text>
                    <Show when={fp != null}>
                      <box flexDirection="row" height={1}><text fg={C.muted} width={10}>points</text><text fg={fp! >= 0.9 ? C.error : fp! >= 0.75 ? C.warn : C.ok} width={barW() + 1}>{bar(fp!, barW())}</text>
                        <text fg={C.text}>{`${Math.round(fp! * 100)} %  ${fmt(s.spentPoints)} / ${fmt(e.amountPoints!)}  · reste ${fmt(Math.max(0, s.remainingPoints!))}`}</text></box>
                    </Show>
                    <Show when={ft != null}>
                      <box flexDirection="row" height={1}><text fg={C.muted} width={10}>tokens</text><text fg={ft! >= 0.9 ? C.error : ft! >= 0.75 ? C.warn : C.ok} width={barW() + 1}>{bar(ft!, barW())}</text>
                        <text fg={C.text}>{`${Math.round(ft! * 100)} %  ${fmt(s.spentTokens)} / ${fmt(e.tokenLimit!)}  · reste ${fmt(Math.max(0, s.remainingTokens!))}`}</text></box>
                    </Show>
                  </box>
                )
              }}
            </For>
          </Show>
        </Section>

        <text fg={C.dim}>mesuré : renvoyé par le fournisseur · estimé : calculé par Eclipse (prix du catalogue × tokens) · saisi : entré à la main (/spent)</text>
      </scrollbox>
    </box>
  )
}
