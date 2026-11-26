import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Budget, dayStart, estimateUsd, tokens } from "../src/core/budget"
import { bar, spark } from "../src/ui/UsageScreen"

let dir: string
let b: Budget
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-budget-"))
  b = new Budget(join(dir, "budget.db"))
})
afterEach(() => {
  b.close()
  rmSync(dir, { recursive: true, force: true })
})

test("natures gardées séparées ; points estimés seulement avec un taux saisi", () => {
  b.record({ session: "s1", model: "m1", tokensIn: 100, tokensOut: 50, measured: true, usd: 0.002 })
  b.record({ session: "s1", model: "m1", tokensIn: 10, tokensOut: 5, measured: false, usd: 0.001, rate: 300 })
  const t = b.totals(0, { session: "s1" })
  expect(t.requests).toBe(2)
  expect(t.tokensIn).toEqual({ measured: 100, estimated: 10 })
  expect(t.points.estimated).toBeCloseTo(0.3)
  expect(t.pointsUnavailable).toBe(1)
  expect(tokens(t)).toBe(165)
  expect(b.totals(0, { session: "autre" }).requests).toBe(0)
})

test("par modèle trié, activité par jour", () => {
  b.record({ session: "s", model: "petit", tokensIn: 1, tokensOut: 1, measured: true })
  b.record({ session: "s", model: "gros", tokensIn: 500, tokensOut: 500, measured: true })
  expect(b.byModel(0).map((m) => m.model)).toEqual(["gros", "petit"])
  const d = b.daily(7)
  expect(d.length).toBe(7)
  expect(d[6].day).toBe(dayStart())
  expect(d[6].tokens).toBe(1002)
})

test("limite de tokens « pause » : l'envoi est bloqué une fois atteinte", () => {
  b.setEnvelope({ kind: "limit", name: "limite", amountPoints: null, tokenLimit: 100, periodS: 3600 })
  expect(b.blocked("m")).toBeNull()
  b.record({ session: "s", model: "m", tokensIn: 80, tokensOut: 30, measured: true })
  expect(b.blocked("m")).toContain("limite « limite » atteinte")
  b.clearEnvelope("limit")
  expect(b.blocked("m")).toBeNull()
})

test("barres et activité lisibles sans couleur", () => {
  expect(bar(0.5, 10)).toBe("█████░░░░░")
  expect(bar(2, 4)).toBe("████")
  expect(spark([0, 1, 8])).toBe("·▁█")
  expect(estimateUsd(2, 10, 1_000_000, 100_000)).toBeCloseTo(3)
  expect(estimateUsd(undefined, 1, 1, 1)).toBeNull()
})
