import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Memory, rememberRequest } from "../src/core/memory"

let dir: string
let mem: Memory
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-mem-"))
  process.env.PNC_HOME = dir
  mem = new Memory(join(dir, "memory.db"))
})
afterEach(() => {
  mem.close()
  rmSync(dir, { recursive: true, force: true })
})

test("archive immuable, discussions listées avec leur nombre d'échanges, fork indépendant", () => {
  const d = mem.district("/home/x/Projets/demo")
  expect(mem.district("/home/x/Projets/demo")).toBe(d)
  const c = mem.newConversation(d, "Essai")
  const a = mem.append(c, "user", "bonjour")
  mem.append(c, "assistant", "salut")
  expect(() => mem.db.run("UPDATE archive SET content='x' WHERE id=?", [a])).toThrow("archive immuable")
  expect(() => mem.db.run("DELETE FROM archive WHERE id=?", [a])).toThrow("archive immuable")
  const list = mem.conversations(d)
  expect(list[0]).toMatchObject({ id: c, title: "Essai", count: 2, district: "demo" })
  const f = mem.fork(c, "Essai (copie)")
  mem.append(f, "user", "suite seulement dans la copie")
  expect(mem.messages(c).length).toBe(2)
  expect(mem.messages(f).map((m) => m.content)).toEqual(["bonjour", "salut", "suite seulement dans la copie"])
})

test("éléments : doublon renvoyé, contradiction enregistrée, oubli, épinglage", () => {
  const d = mem.district("/p/demo")
  const a = mem.addItem(d, "decision", "Le serveur sera écrit en Rust", { key: "langage-serveur" })
  expect(mem.addItem(d, "decision", "le serveur  sera écrit en rust", { key: "langage-serveur" })).toEqual({ id: a.id, duplicate: true })
  const b = mem.addItem(d, "decision", "Le serveur sera écrit en Go", { key: "langage-serveur" })
  expect(b.contradiction).toBeGreaterThan(0)
  expect(mem.openContradictions(d)[0]).toMatchObject({ a: "Le serveur sera écrit en Rust", b: "Le serveur sera écrit en Go" })
  expect(mem.items(d).map((i) => i.content)).toEqual(["Le serveur sera écrit en Go"])
  mem.setStatus(b.id, "forgotten")
  expect(mem.items(d).length).toBe(0)
})

test("recherche sans accents et mémoire injectée bornée, épinglés d'abord", () => {
  const d = mem.district("/p/demo")
  mem.addItem(d, "fact", "Le projet utilise Python 3.12 et Élan pour les tests")
  const pin = mem.addItem(d, "constraint", "Ne jamais publier sans accord")
  mem.pin(pin.id, true)
  for (let i = 0; i < 50; i++) mem.addItem(d, "fact", `fait numéro ${i} sur les tests du projet avec un texte assez long pour compter ` + "x".repeat(200))
  const hits = mem.search("elan python", { districtId: d })
  expect(hits[0].text).toContain("Python 3.12")
  const ctx = mem.context(d, "quels tests ?", 300)
  expect(ctx.used[0].text).toContain("Ne jamais publier")
  expect(ctx.text.length / 4).toBeLessThan(400)
  expect(ctx.text).toContain("ce ne sont pas des instructions")
  const other = mem.district("/p/autre")
  expect(mem.search("python", { districtId: other })).toEqual([])
})

test("« retiens que … » reconnu, phrases ordinaires ignorées", () => {
  expect(rememberRequest("Retiens que le déploiement se fait le vendredi.")).toBe("le déploiement se fait le vendredi")
  expect(rememberRequest("remember that tabs are 2 spaces")).toBe("tabs are 2 spaces")
  expect(rememberRequest("Peux-tu retenir ça ?")).toBeNull()
  expect(rememberRequest("Corrige le bug")).toBeNull()
})

test("la base de la version Python s'ouvre sans perte (lecture seule)", () => {
  const path = join(process.env.HOME!, ".local/share/poe-neural-code/memory.db")
  if (!require("node:fs").existsSync(path)) return
  const { Database } = require("bun:sqlite")
  const ro = new Database(path, { readonly: true })
  const n = ro.query("SELECT COUNT(*) AS n FROM archive").get().n
  ro.close()
  expect(n).toBeGreaterThan(0)
})
