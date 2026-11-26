/**
 * Réglages de la nouvelle version : fournisseur et modèle choisis, modèles récemment utilisés.
 * Fichier à part (`eclipse.json`) pour ne pas modifier la configuration de la version Python pendant la transition ;
 * au premier lancement, les modèles récents de l'ancienne configuration sont repris.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "./paths"

export interface Choice {
  kind: "api" | "agent"
  provider: string // id du fournisseur ou de l'agent
  model?: string // vide pour un agent qui garde son modèle par défaut
}

export interface Recent extends Choice {
  at: number
}

export interface Prefs {
  theme?: "eclipse" | "contraste" | "clair" | "sans-couleur"
  icons?: "nerd" | "texte"
  lang?: "fr" | "en"
  showThinking?: boolean
  mode?: "build" | "plan"
  effort?: Record<string, string> // « fournisseur/modèle » -> rapide | normal | profond | valeur exacte
  rate?: number // taux points Poe par dollar, saisi par l'utilisateur (/rate)
  options?: Record<string, Record<string, unknown>> // « fournisseur/modèle » -> réglages du catalogue (/options)
  sidebar?: boolean
  sandbox?: boolean // défaut : active
  cgLead?: "claude" | "codex"
  cgMode?: "auto" | "seul" | "delegue"
  cgReview?: boolean
  cgSubagents?: boolean
  system?: string // consignes personnelles (/system set)
  fusion?: string[] // assistants consultables : « fournisseur/modèle » ou « agent:id »
  fusionOn?: boolean
  automations?: { id: number; every: number; prompt: string; paused?: boolean; last?: number }[]
  agents?: Record<string, { model?: string; effort?: string; power?: "lecture" | "modifications" | "commandes" }> // réglages par agent
}

export interface State {
  current?: Choice
  recents: Recent[]
  agentPaths: Record<string, string>
  prefs: Prefs
}

const MAX_RECENTS = 8

export function statePath(): string {
  return join(dataDir(), "eclipse.json")
}

export function load(): State {
  const p = statePath()
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8"))
      return { current: s.current, recents: Array.isArray(s.recents) ? s.recents : [], agentPaths: s.agentPaths ?? {}, prefs: s.prefs ?? {} }
    } catch {
      // fichier abîmé : on repart à vide sans l'écraser tant qu'aucun choix n'est fait
    }
  }
  const st: State = { recents: [], agentPaths: {}, prefs: {} }
  try {
    const old = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"))
    // date d'utilisation inconnue dans l'ancienne configuration : 0 (affiché « ancienne version »), ordre conservé
    ;(old.recent_models ?? []).slice(0, MAX_RECENTS).forEach((m: string) => st.recents.push({ kind: "api", provider: "poe", model: m, at: 0 }))
    if (old.agent_paths) st.agentPaths = { ...old.agent_paths }
  } catch {}
  return st
}

export function save(st: State): void {
  mkdirSync(dataDir(), { recursive: true })
  const p = statePath()
  const tmp = p + ".tmp"
  writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}

export function sameChoice(a: Choice, b: Choice): boolean {
  return a.kind === b.kind && a.provider === b.provider && (a.model ?? "") === (b.model ?? "")
}

/** Enregistre le choix et le place en tête des récents (plusieurs gardés, sans doublon). */
export function choose(st: State, c: Choice, now = Date.now()): State {
  const recents = [{ ...c, at: now }, ...st.recents.filter((r) => !sameChoice(r, c))].slice(0, MAX_RECENTS)
  return { ...st, current: c, recents }
}
