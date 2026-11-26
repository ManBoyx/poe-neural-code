import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Memory } from "../src/core/memory"
import { isDestructive, Permissions, type Decision, type Request } from "../src/core/permissions"
import { Snapshots } from "../src/core/snapshots"
import { runTool, type ToolEnv } from "../src/core/tools"

let dir: string
let proj: string
let asked: Request[]
let answer: Decision
let env: ToolEnv
let mem: Memory

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-tools-"))
  process.env.PNC_HOME = join(dir, "data")
  proj = join(dir, "proj")
  mkdirSync(proj)
  writeFileSync(join(proj, "a.txt"), "un\ndeux\ntrois\n")
  asked = []
  answer = "once"
  mem = new Memory(join(dir, "mem.db"))
  env = { roots: [proj], perms: new Permissions(async (r) => (asked.push(r), answer)), memory: mem, districtId: mem.district(proj), todos: [] }
})
afterEach(() => {
  mem.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (name: string, a: unknown) => runTool(env, { id: "1", name, args: JSON.stringify(a) })

test("lecture libre dans le projet, confirmée hors du projet", async () => {
  expect((await call("read_file", { path: "a.txt" })).output).toContain("    2  deux")
  expect(asked.length).toBe(0)
  writeFileSync(join(dir, "dehors.txt"), "secret")
  answer = "deny"
  const r = await call("read_file", { path: "../dehors.txt" })
  expect(r.ok).toBe(false)
  expect(asked[0].outside).toBe(true)
})

test("modification : diff montré, refus respecté, passage unique exigé", async () => {
  answer = "deny"
  const r = await call("edit_file", { path: "a.txt", old: "deux", new: "2" })
  expect(r.ok).toBe(false)
  expect(asked[0].detail).toContain("-deux")
  expect(asked[0].detail).toContain("+2")
  expect(readFileSync(join(proj, "a.txt"), "utf8")).toContain("deux")
  answer = "once"
  expect((await call("edit_file", { path: "a.txt", old: "deux", new: "2" })).ok).toBe(true)
  expect(readFileSync(join(proj, "a.txt"), "utf8")).toBe("un\n2\ntrois\n")
  expect((await call("edit_file", { path: "a.txt", old: "absent", new: "x" })).output).toContain("introuvable")
})

test("modes : lecture seule refuse, modifications accepte sans demander, « toujours » retenu", async () => {
  env.perms.mode = "lecture"
  expect((await call("write_file", { path: "b.txt", content: "x" })).ok).toBe(false)
  expect(asked.length).toBe(0)
  env.perms.mode = "modifications"
  expect((await call("write_file", { path: "b.txt", content: "x" })).ok).toBe(true)
  expect(asked.length).toBe(0)
  env.perms.mode = "demander"
  answer = "session"
  expect((await call("run_command", { command: "echo bonjour" })).output).toBe("bonjour")
  expect((await call("run_command", { command: "echo encore" })).output).toBe("encore")
  expect(asked.length).toBe(1) // la seconde commande « echo » est couverte par « toujours pour cette session »
})

test("bypass seulement après vérification ; destructif toujours confirmé ; sudo interdit", async () => {
  expect(() => env.perms.setMode("bypass")).toThrow()
  env.perms.bypassVerified = true
  env.perms.setMode("bypass")
  expect((await call("run_command", { command: "echo ok" })).ok).toBe(true)
  expect(asked.length).toBe(0)
  answer = "deny"
  expect((await call("run_command", { command: "rm -rf build" })).ok).toBe(false)
  expect(asked[0].destructive).toBe(true)
  expect((await call("run_command", { command: "sudo ls" })).output).toContain("sudo n'est pas permis")
  expect(isDestructive("git push --force origin main")).toBe(true)
  expect(isDestructive("git status")).toBe(false)
})

test("commande : délai dépassé arrêté, sortie bornée", async () => {
  env.perms.bypassVerified = true
  env.perms.setMode("bypass-total")
  const r = await call("run_command", { command: "sleep 30", timeout_s: 1 })
  expect(r.ok).toBe(false)
  expect(r.output).toContain("délai de 1 s dépassé")
  const big = await call("run_command", { command: "seq 1 100000" })
  expect(big.output).toContain("caractères coupés")
})

test("tâches et mémoire par outil", async () => {
  await call("todo_write", { items: [{ text: "écrire les tests", status: "en cours" }] })
  expect(env.todos).toEqual([{ text: "écrire les tests", status: "en cours" }])
  await call("memory_note", { kind: "decision", content: "On utilise Bun" })
  expect((await call("memory_search", { query: "bun" })).output).toContain("On utilise Bun")
})

test("instantanés : annuler remet les fichiers modifiés, supprimés et retire les ajoutés", async () => {
  const s = new Snapshots(proj)
  const before = (await s.snapshot("avant"))!
  writeFileSync(join(proj, "a.txt"), "changé\n")
  writeFileSync(join(proj, "nouveau.txt"), "x")
  const r = await s.restore(before)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(proj, "a.txt"), "utf8")).toBe("un\ndeux\ntrois\n")
  expect(existsSync(join(proj, "nouveau.txt"))).toBe(false)
  expect(existsSync(join(proj, ".git"))).toBe(false) // le dépôt du projet n'est jamais créé ni touché
})

test("bypass : mot de passe vérifié par polkit, jamais par sudo ; échec et annulation expliqués", async () => {
  const { verifyPassword } = await import("../src/core/auth")
  if (process.platform === "win32" || !Bun.which("pkexec")) return
  let seen: string[] = []
  expect(await verifyPassword(async (c) => ((seen = c), 0))).toEqual({ ok: true })
  expect(seen[0]).toContain("pkexec")
  expect(seen.join(" ")).not.toContain("sudo")
  expect(await verifyPassword(async () => 126)).toEqual({ ok: false, reason: "authentification refusée ou annulée" })
  expect(await verifyPassword(async () => 127)).toEqual({ ok: false, reason: "aucune fenêtre d'authentification disponible" })
})

test("sandbox : la commande écrit dans le projet, pas ailleurs ; le bypass ne la désactive pas", async () => {
  const { available } = await import("../src/core/sandbox")
  if (!available().ok) return
  env.sandbox = true
  env.perms.bypassVerified = true
  env.perms.setMode("bypass-total")
  // hors du projet et hors de /tmp (la sandbox donne un /tmp privé) : dans le dossier personnel
  const outside = join(require("node:os").homedir(), `.eclipse-test-hors-projet-${process.pid}.txt`)
  const r = await call("run_command", { command: `echo dedans > ok.txt && cat ok.txt; echo x > ${outside}` })
  expect(r.output).toContain("dedans")
  expect(readFileSync(join(proj, "ok.txt"), "utf8")).toBe("dedans\n")
  expect(existsSync(outside)).toBe(false)
  expect(r.output).toMatch(/lecture seule|Read-only/i)
  env.sandbox = false
  await call("run_command", { command: `echo x > ${outside}` })
  expect(existsSync(outside)).toBe(true)
  rmSync(outside)
})

test("garde : sandbox coupée et bypass total, une commande ne peut toujours pas écrire dans les fichiers d'Eclipse", async () => {
  if (process.platform !== "linux" || !Bun.which("bwrap")) {
    if (process.env.ECLIPSE_REQUIRE_BWRAP === "1") throw new Error("bubblewrap requis pour ce test (ECLIPSE_REQUIRE_BWRAP=1)")
    return
  }
  mkdirSync(process.env.PNC_HOME!, { recursive: true }) // dossier de données d'Eclipse (protégé)
  env.sandbox = false
  env.perms.bypassVerified = true
  env.perms.setMode("bypass-total")
  const target = join(process.env.PNC_HOME!, "ecrit-par-un-modele.txt")
  const r = await call("run_command", { command: `echo dedans > ok.txt; echo x > ${target}; echo fin` })
  expect(readFileSync(join(proj, "ok.txt"), "utf8")).toBe("dedans\n") // le projet reste modifiable
  expect(existsSync(target)).toBe(false)
  expect(r.output).toMatch(/lecture seule|Read-only/i)
})

test("garde : l'arrêt sur délai tue aussi les petits-enfants (aucun orphelin)", async () => {
  if (process.platform !== "linux" || !Bun.which("bwrap")) {
    if (process.env.ECLIPSE_REQUIRE_BWRAP === "1") throw new Error("bubblewrap requis pour ce test (ECLIPSE_REQUIRE_BWRAP=1)")
    return
  }
  env.sandbox = false
  env.perms.bypassVerified = true
  env.perms.setMode("bypass")
  const mark = 300 + (process.pid % 600)
  const r = await call("run_command", { command: `sh -c 'sleep ${mark}.5 & wait' & wait`, timeout_s: 1 })
  expect(r.ok).toBe(false)
  await Bun.sleep(300)
  const left = Bun.spawnSync(["pgrep", "-f", `^sleep ${mark}\\.5$`]).stdout.toString().trim()
  expect(left).toBe("")
})

test("garde : un descendant qui crée sa propre session meurt aussi au délai, et /proc ne montre pas l'hôte", async () => {
  if (process.platform !== "linux" || !Bun.which("bwrap")) {
    if (process.env.ECLIPSE_REQUIRE_BWRAP === "1") throw new Error("bubblewrap requis pour ce test (ECLIPSE_REQUIRE_BWRAP=1)")
    return
  }
  env.sandbox = false
  env.perms.bypassVerified = true
  env.perms.setMode("bypass")
  const mark = 900 + (process.pid % 90)
  const r = await call("run_command", { command: `setsid sleep ${mark}.7 >/dev/null 2>&1 < /dev/null & sleep 30`, timeout_s: 1 })
  expect(r.ok).toBe(false)
  await Bun.sleep(400)
  expect(Bun.spawnSync(["pgrep", "-f", `^sleep ${mark}\\.7$`]).stdout.toString().trim()).toBe("")
  const ps = await call("run_command", { command: `ls /proc | grep -c '^[0-9]'` })
  expect(Number(ps.output.trim().split("\n")[0])).toBeLessThan(10)
})
