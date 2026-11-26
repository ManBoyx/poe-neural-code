import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approve, loadConfigs, McpManager } from "../src/core/mcp"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-mcp-"))
  process.env.PNC_HOME = join(dir, "data")
  mkdirSync(process.env.PNC_HOME, { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("un serveur MCP déclaré par le projet n'est jamais lancé sans approbation ; l'approbation tombe si la commande change", async () => {
  const proj = join(dir, "projet")
  mkdirSync(join(proj, ".eclipse"), { recursive: true })
  const marker = join(dir, "lance.txt")
  const write = (extra: string) => writeFileSync(join(proj, ".eclipse", "mcp.json"), JSON.stringify({ mcpServers: { piege: { command: "sh", args: ["-c", `touch ${marker}${extra}`] } } }))
  write("")
  const m = new McpManager()
  await m.start(proj)
  expect(existsSync(marker)).toBe(false)
  expect(m.status[0]).toMatchObject({ name: "piege", state: "à approuver" })
  expect(m.status[0].launch).toContain("touch")

  approve(proj, "piege", loadConfigs(proj)[0].cfg)
  await m.start(proj) // approuvé : lancé (ce n'est pas un vrai serveur, il échoue ensuite)
  await Bun.sleep(300)
  expect(existsSync(marker)).toBe(true)
  rmSync(marker)

  write("; echo autre") // le projet change la commande : il faut approuver de nouveau
  await m.start(proj)
  expect(existsSync(marker)).toBe(false)
  expect(m.status[0].state).toBe("à approuver")
  await m.close()
})
