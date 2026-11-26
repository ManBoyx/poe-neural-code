/**
 * Registre local de consommation, sur la même base que la version Python (`budget.db`) : l'historique est commun.
 *
 * Chaque valeur garde sa nature : « measured » (renvoyée par le fournisseur), « estimated » (calculée par Eclipse),
 * « manual » (saisie à la main), « unavailable ». Rien n'est additionné entre natures sans le dire.
 * Les points Poe ne sont estimés que si l'utilisateur a saisi un taux points/USD (/rate) : pas de conversion inventée.
 * Ce registre ne contient que ce qu'Eclipse a dépensé, pas l'historique complet du compte.
 */
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "./paths"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS envelopes(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'temporary',
  amount_points REAL, token_limit INTEGER, period_s INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT '["*"]', on_exhaust TEXT NOT NULL DEFAULT 'pause', carry_over INTEGER NOT NULL DEFAULT 0,
  carried REAL NOT NULL DEFAULT 0, period_start REAL NOT NULL, period_end REAL,
  last_alert INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, session_id TEXT, model TEXT,
  tokens_in INTEGER, tokens_out INTEGER, tokens_kind TEXT NOT NULL,
  points REAL, points_kind TEXT NOT NULL, usd REAL, note TEXT);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, session_id TEXT, model TEXT, points REAL, tokens INTEGER,
  state TEXT NOT NULL DEFAULT 'held');
`

export type Nature = "measured" | "estimated" | "manual" | "unavailable"
export const NATURE_FR: Record<Nature, string> = { measured: "mesuré", estimated: "estimé", manual: "saisi", unavailable: "indisponible" }

export interface Totals {
  requests: number
  tokensIn: { measured: number; estimated: number }
  tokensOut: { measured: number; estimated: number }
  usd: number // estimé (prix du catalogue × tokens)
  points: { measured: number; estimated: number; manual: number }
  pointsUnavailable: number
}

export interface ModelRow extends Totals {
  model: string
}

export interface Envelope {
  id: number
  name: string
  kind: string
  amountPoints: number | null
  tokenLimit: number | null
  periodS: number
  scope: string[]
  onExhaust: string
  periodStart: number
  periodEnd: number | null
}

export interface EnvelopeStatus {
  envelope: Envelope
  spentPoints: number
  spentTokens: number
  remainingPoints: number | null
  remainingTokens: number | null
}

const now = () => Date.now() / 1000

export function dayStart(t = now()): number {
  const d = new Date(t * 1000)
  d.setHours(0, 0, 0, 0)
  return d.getTime() / 1000
}
export function weekStart(t = now()): number {
  const d = new Date(dayStart(t) * 1000)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // lundi
  return d.getTime() / 1000
}
export function monthStart(t = now()): number {
  const d = new Date(t * 1000)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime() / 1000
}

function empty(): Totals {
  return { requests: 0, tokensIn: { measured: 0, estimated: 0 }, tokensOut: { measured: 0, estimated: 0 }, usd: 0,
           points: { measured: 0, estimated: 0, manual: 0 }, pointsUnavailable: 0 }
}

function add(t: Totals, r: any): void {
  t.requests++
  t.usd += r.usd ?? 0
  if (r.tokens_kind === "measured" || r.tokens_kind === "estimated") {
    t.tokensIn[r.tokens_kind as "measured"] += r.tokens_in ?? 0
    t.tokensOut[r.tokens_kind as "measured"] += r.tokens_out ?? 0
  }
  if (r.points == null || r.points_kind === "unavailable") t.pointsUnavailable++
  else if (r.points_kind in t.points) t.points[r.points_kind as "measured"] += r.points
}

export function tokens(t: Totals): number {
  return t.tokensIn.measured + t.tokensIn.estimated + t.tokensOut.measured + t.tokensOut.estimated
}

export class Budget {
  db: Database

  constructor(path = join(dataDir(), "budget.db")) {
    if (path !== ":memory:") mkdirSync(dataDir(), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /** Enregistre une réponse. `usd` estimé d'après le prix du catalogue ; points estimés seulement avec un taux saisi. */
  record(e: { session: string; model: string; tokensIn?: number; tokensOut?: number; measured: boolean; usd?: number | null; rate?: number | null; note?: string }): number {
    const usd = e.usd ?? null
    const points = usd != null && e.rate ? usd * e.rate : null
    return Number(this.db.query(
      "INSERT INTO ledger(ts,session_id,model,tokens_in,tokens_out,tokens_kind,points,points_kind,usd,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(now(), e.session, e.model, e.tokensIn ?? null, e.tokensOut ?? null, e.tokensIn != null || e.tokensOut != null ? (e.measured ? "measured" : "estimated") : "unavailable",
          points, points == null ? "unavailable" : "estimated", usd, e.note ?? "").lastInsertRowid)
  }

  addManual(session: string, points: number, note = "saisie manuelle"): number {
    return Number(this.db.query("INSERT INTO ledger(ts,session_id,model,tokens_in,tokens_out,tokens_kind,points,points_kind,usd,note) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(now(), session, null, null, null, "unavailable", points, "manual", null, note).lastInsertRowid)
  }

  totals(since: number, opts: { session?: string; until?: number } = {}): Totals {
    const t = empty()
    const rows = this.db.query(`SELECT * FROM ledger WHERE ts>=? AND ts<?${opts.session ? " AND session_id=?" : ""}`)
      .all(since, opts.until ?? 1e12, ...(opts.session ? [opts.session] : [])) as any[]
    for (const r of rows) add(t, r)
    return t
  }

  byModel(since: number): ModelRow[] {
    const out = new Map<string, ModelRow>()
    for (const r of this.db.query("SELECT * FROM ledger WHERE ts>=?").all(since) as any[]) {
      const k = r.model ?? "saisie manuelle"
      if (!out.has(k)) out.set(k, { model: k, ...empty() })
      add(out.get(k)!, r)
    }
    return [...out.values()].sort((a, b) => tokens(b) - tokens(a) || b.requests - a.requests)
  }

  /** Tokens par jour sur les `days` derniers jours (le plus ancien d'abord). */
  daily(days: number, t = now()): { day: number; tokens: number; requests: number }[] {
    const start = dayStart(t) - (days - 1) * 86400
    const out = Array.from({ length: days }, (_, i) => ({ day: start + i * 86400, tokens: 0, requests: 0 }))
    for (const r of this.db.query("SELECT ts, COALESCE(tokens_in,0)+COALESCE(tokens_out,0) AS n FROM ledger WHERE ts>=?").all(start) as any[]) {
      const i = Math.floor((dayStart(r.ts) - start) / 86400 + 0.5)
      if (out[i]) {
        out[i].tokens += r.n
        out[i].requests++
      }
    }
    return out
  }

  envelopes(activeOnly = true): Envelope[] {
    return (this.db.query(`SELECT * FROM envelopes${activeOnly ? " WHERE active=1" : ""} ORDER BY id`).all() as any[]).map((r) => ({
      id: r.id, name: r.name, kind: r.kind, amountPoints: r.amount_points, tokenLimit: r.token_limit, periodS: r.period_s,
      scope: JSON.parse(r.scope || '["*"]'), onExhaust: r.on_exhaust, periodStart: r.period_start, periodEnd: r.period_end,
    }))
  }

  setEnvelope(e: { kind: string; name: string; amountPoints: number | null; tokenLimit: number | null; periodS: number; scope?: string[]; onExhaust?: "pause" | "warn" }): number {
    this.db.query("UPDATE envelopes SET active=0 WHERE kind=?").run(e.kind)
    const t = now()
    return Number(this.db.query("INSERT INTO envelopes(name,kind,amount_points,token_limit,period_s,scope,on_exhaust,carry_over,carried,period_start,period_end,active,created) VALUES(?,?,?,?,?,?,?,0,0,?,?,1,?)")
      .run(e.name, e.kind, e.amountPoints, e.tokenLimit, e.periodS, JSON.stringify(e.scope ?? ["*"]), e.onExhaust ?? "pause", t, e.periodS ? t + e.periodS : null, t).lastInsertRowid)
  }

  clearEnvelope(kind: string): void {
    this.db.query("UPDATE envelopes SET active=0 WHERE kind=?").run(kind)
  }

  /** Renouvelle une enveloppe dont la période est finie (repart de zéro ; ne crée aucun point chez le fournisseur). */
  private roll(e: Envelope): Envelope {
    if (!e.periodS || !e.periodEnd || now() < e.periodEnd) return e
    const n = Math.floor((now() - e.periodStart) / e.periodS)
    const start = e.periodStart + n * e.periodS
    this.db.query("UPDATE envelopes SET period_start=?, period_end=? WHERE id=?").run(start, start + e.periodS, e.id)
    return { ...e, periodStart: start, periodEnd: start + e.periodS }
  }

  status(e0: Envelope): EnvelopeStatus {
    const e = this.roll(e0)
    const inScope = (m: string | null) => e.scope.includes("*") || (m != null && (e.scope.includes(m) || e.scope.some((s) => s.endsWith("*") && m.startsWith(s.slice(0, -1)))))
    let sp = 0
    let stok = 0
    for (const r of this.db.query("SELECT model, points, points_kind, tokens_kind, COALESCE(tokens_in,0)+COALESCE(tokens_out,0) AS t FROM ledger WHERE ts>=?").all(e.periodStart) as any[]) {
      if (!inScope(r.model)) continue
      if (r.points != null && r.points_kind !== "unavailable") sp += r.points
      if (r.tokens_kind !== "unavailable") stok += r.t
    }
    return { envelope: e, spentPoints: sp, spentTokens: stok,
             remainingPoints: e.amountPoints == null ? null : e.amountPoints - sp, remainingTokens: e.tokenLimit == null ? null : e.tokenLimit - stok }
  }

  /** Une enveloppe « pause » épuisée bloque l'envoi : renvoie la raison, sinon null. */
  blocked(model: string): string | null {
    for (const e of this.envelopes()) {
      const s = this.status(e)
      const inScope = e.scope.includes("*") || e.scope.includes(model)
      if (!inScope || e.onExhaust !== "pause") continue
      if (s.remainingTokens != null && s.remainingTokens <= 0) return `limite « ${e.name} » atteinte : ${s.spentTokens} / ${e.tokenLimit} tokens`
      if (s.remainingPoints != null && s.remainingPoints <= 0) return `budget « ${e.name} » épuisé : ${s.spentPoints.toFixed(1)} / ${e.amountPoints} points`
    }
    return null
  }
}

/** Prix estimé d'une réponse d'après le catalogue ($ par million de tokens). */
export function estimateUsd(priceIn: number | undefined, priceOut: number | undefined, tin: number, tout: number): number | null {
  if (priceIn == null || priceOut == null) return null
  return (priceIn * tin + priceOut * tout) / 1e6
}
