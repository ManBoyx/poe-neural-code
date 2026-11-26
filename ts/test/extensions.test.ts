import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPlugins, discoverSkills, loadPlugins, setTrust } from "../src/core/extensions"
import { McpManager } from "../src/core/mcp"

let dir: string
let proj: string
const home0 = process.env.HOME
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-ext-"))
  proj = join(dir, "proj")
  mkdirSync(proj)
  process.env.HOME = join(dir, "home")
  process.env.PNC_HOME = join(dir, "data")
  mkdirSync(process.env.HOME, { recursive: true })
})
afterEach(() => {
  process.env.HOME = home0
  rmSync(dir, { recursive: true, force: true })
})

test("skills : projet et global, nom et description lus dans SKILL.md", () => {
  mkdirSync(join(proj, ".claude/skills/tests"), { recursive: true })
  writeFileSync(join(proj, ".claude/skills/tests/SKILL.md"), "---\nname: tests\ndescription: Lancer les tests du projet\n---\nContenu")
  mkdirSync(join(process.env.HOME!, ".claude/skills/synced/x/montage"), { recursive: true })
  writeFileSync(join(process.env.HOME!, ".claude/skills/synced/x/montage/SKILL.md"), "---\nname: montage\ndescription: >-\n  Monter une vidéo\n  de gameplay\n---\n")
  const s = discoverSkills(proj)
  expect(s.map((x) => `${x.name}:${x.scope}`)).toEqual(["montage:global", "tests:projet"])
  expect(s[0].description).toBe("Monter une vidéo de gameplay")
})

test("plugins : jamais exécutés sans confiance ; fichier modifié = confiance à redonner", async () => {
  mkdirSync(join(proj, ".eclipse/plugins"), { recursive: true })
  const f = join(proj, ".eclipse/plugins/salut.ts")
  writeFileSync(f, 'export default (api: any) => api.command("salut", "Dire bonjour", (a: string) => "bonjour " + a)')
  let list = discoverPlugins(proj)
  expect(list[0].trusted).toBe(false)
  expect(await loadPlugins(list)).toEqual([])
  setTrust(list[0], true)
  list = discoverPlugins(proj)
  const cmds = await loadPlugins(list)
  expect(cmds.map((c) => c.name)).toEqual(["salut"])
  expect(cmds[0].run("toi")).toBe("bonjour toi")
  writeFileSync(f, 'export default (api: any) => api.command("salut", "x", () => "changé")')
  expect(discoverPlugins(proj)[0].trusted).toBe(false)
})

test("MCP : un petit serveur local, ses outils listés et appelés ; un serveur cassé n'empêche pas les autres", async () => {
  const server = join(dir, "serveur-mcp.ts")
  writeFileSync(server, `
import { McpServer } from "${join(import.meta.dir, "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")}"
import { StdioServerTransport } from "${join(import.meta.dir, "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")}"
import { z } from "${join(import.meta.dir, "../node_modules/zod/index.js")}"
const s = new McpServer({ name: "essai", version: "1.0.0" })
s.registerTool("addition", { description: "Additionne", inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }))
await s.connect(new StdioServerTransport())
`)
  mkdirSync(process.env.PNC_HOME!, { recursive: true })
  writeFileSync(join(process.env.PNC_HOME!, "mcp.json"), JSON.stringify({ mcpServers: {
    essai: { command: process.execPath, args: [server] },
    casse: { command: "/chemin/inexistant" },
  } }))
  const m = new McpManager()
  await m.start(proj)
  expect(m.status.find((s) => s.name === "essai")).toMatchObject({ state: "connecté", tools: 1 })
  expect(m.status.find((s) => s.name === "casse")!.state).toBe("erreur")
  const tool = m.find("mcp__essai__addition")!
  expect(tool.readOnly).toBe(true)
  expect(await m.call(tool, { a: 2, b: 3 })).toEqual({ ok: true, output: "5" })
  await m.close()
}, 30_000)
