import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eclipseRoot, guardPaths, isProtected, listProjects, needsProject, openProject, slug } from "../src/core/protect"
import { Memory } from "../src/core/memory"
import { Permissions } from "../src/core/permissions"
import { runTool } from "../src/core/tools"
import { runAgent } from "../src/core/agents"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-protect-"))
  process.env.ECLIPSE_PROJECTS = join(dir, "Projets")
  process.env.PNC_HOME = join(dir, "data")
})
afterEach(() => {
  delete process.env.ECLIPSE_PROJECTS
  rmSync(dir, { recursive: true, force: true })
})

test("les fichiers d'Eclipse sont protégés ; un projet ne l'est pas", () => {
  expect(isProtected(join(eclipseRoot(), "README.md"))).toBe(true)
  expect(isProtected(join(eclipseRoot(), "ts/src/nouveau.ts"))).toBe(true)
  expect(isProtected(join(process.env.PNC_HOME!, "memory.db"))).toBe(true)
  expect(isProtected(join(dir, "Projets", "snake"))).toBe(false)
  expect(needsProject(eclipseRoot())).toBe(true)
  expect(needsProject(join(dir, "Projets"))).toBe(true)
})

test("un dossier par projet dans ~/Projets, créé s'il manque, retrouvé ensuite", () => {
  expect(slug("Faites un snake à deux")).toBe("snake-a-deux")
  const p = openProject("snake-a-deux")
  expect(p).toBe(join(dir, "Projets", "snake-a-deux"))
  expect(existsSync(p)).toBe(true)
  expect(needsProject(p)).toBe(false)
  expect(listProjects().map((x) => x.name)).toEqual(["snake-a-deux"])
  expect(openProject("snake-a-deux")).toBe(p) // reprise : même dossier
})

test("même en bypass total, un modèle ne peut pas écrire dans Eclipse", async () => {
  const mem = new Memory(join(dir, "m.db"))
  const perms = new Permissions(async () => "once")
  perms.bypassVerified = true
  perms.setMode("bypass-total")
  const env = { roots: [eclipseRoot()], perms, memory: mem, districtId: mem.district(dir), todos: [] }
  const r = await runTool(env, { id: "1", name: "write_file", args: JSON.stringify({ path: "pirate.txt", content: "x" }) })
  expect(r.ok).toBe(false)
  expect(r.output).toContain("fichier d'Eclipse")
  expect(existsSync(join(eclipseRoot(), "pirate.txt"))).toBe(false)
  const c = await runTool(env, { id: "2", name: "run_command", args: JSON.stringify({ command: "touch pirate.txt" }) })
  expect(c.output).toContain("dossier d'Eclipse")
  mem.close()
})

test("un agent ne démarre pas pour écrire dans Eclipse", async () => {
  const ev: any[] = []
  for await (const e of runAgent({ agent: "claude", binary: "/bin/false", cwd: eclipseRoot(), prompt: "x", power: "modifications" })) ev.push(e)
  expect(ev[0].message).toContain("dossier d'Eclipse")
})

test("une copie des sources d'Eclipse est protégée où qu'elle soit (exécutable compilé sans dépôt connu)", () => {
  const copy = join(dir, "Projets", "eclipse-copie")
  mkdirSync(join(copy, "ts", "src", "core"), { recursive: true })
  writeFileSync(join(copy, "ts", "src", "core", "protect.ts"), "// copie")
  writeFileSync(join(copy, "ts", "src", "core", "cg.ts"), "// copie")
  // copie réduite au CLI (le contenu du dossier ts/ seul)
  const cli = join(dir, "Projets", "eclipse-cli-seul")
  mkdirSync(join(cli, "src", "core"), { recursive: true })
  writeFileSync(join(cli, "src", "core", "protect.ts"), "// copie")
  writeFileSync(join(cli, "src", "core", "cg.ts"), "// copie")
  expect(isProtected(join(cli, "package.json"))).toBe(true)
  expect(guardPaths()).toContain(realpathSync(cli))
  expect(isProtected(join(copy, "README.md"))).toBe(true)
  expect(isProtected(join(copy, "ts", "src", "nouveau", "fichier.ts"))).toBe(true)
  expect(listProjects().some((p) => p.name === "eclipse-copie")).toBe(false)
  expect(isProtected(join(dir, "Projets", "snake", "main.ts"))).toBe(false)
  expect(guardPaths()).toContain(realpathSync(copy))
})
