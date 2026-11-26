import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approve, approveFingerprint, isApproved, loadConfigs, McpManager, pendingProject, revoke, trackedFiles } from "../src/core/mcp"

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

test("l'approbation tombe si le script du projet lancé par le serveur change", async () => {
  const proj = join(dir, "projet2")
  mkdirSync(join(proj, ".eclipse"), { recursive: true })
  writeFileSync(join(proj, "serveur.sh"), "echo v1\n")
  writeFileSync(join(proj, ".eclipse", "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "sh", args: ["./serveur.sh"] } } }))
  const m = new McpManager()
  m.start(proj)
  expect(m.status[0].state).toBe("à approuver") // statut connu dès le retour de start(), avant les connexions
  approveFingerprint(proj, "local", m.status[0].fingerprint!)
  expect(isApproved(proj, "local", loadConfigs(proj)[0].cfg)).toBe(true)
  writeFileSync(join(proj, "serveur.sh"), "echo v2 piégée\n")
  expect(isApproved(proj, "local", loadConfigs(proj)[0].cfg)).toBe(false)
  expect(revoke(proj, "local")).toEqual(["local"])
  // chemins piégés : « ./..serveur.sh » est bien dans le projet, « --fichier=./x » désigne un fichier
  writeFileSync(join(proj, "..serveur.sh"), "a")
  writeFileSync(join(proj, "x.js"), "a")
  expect(trackedFiles(proj, { command: "sh", args: ["./..serveur.sh", "--fichier=./x.js", "../dehors"] })).toEqual(["..serveur.sh", "x.js"])
  // un nom contenant « :: » est retiré correctement avec --tous
  approve(proj, "groupe::local", { command: "true" })
  expect(revoke(proj, "", true)).toEqual(["groupe::local"])
  await m.stopAll()
})

test("configuration mal formée, homonyme d'un serveur global : montrés en erreur, jamais lancés, sans planter", async () => {
  const proj = join(dir, "projet3")
  mkdirSync(join(proj, ".eclipse"), { recursive: true })
  writeFileSync(join(process.env.PNC_HOME!, "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "true", disabled: true } } }))
  writeFileSync(join(proj, ".eclipse", "mcp.json"), JSON.stringify({ mcpServers: { casse: { command: "sh", args: [42] }, docs: { command: "sh", args: ["-c", "touch x"] } } }))
  const m = new McpManager()
  m.start(proj)
  const st = Object.fromEntries(m.status.map((s) => [`${s.source}:${s.name}`, s]))
  expect(st["projet:casse"]).toMatchObject({ state: "erreur" })
  expect(st["projet:casse"].error).toContain("args")
  expect(st["projet:docs"]).toMatchObject({ state: "erreur" })
  expect(st["projet:docs"].error).toContain("serveur global")
  expect(pendingProject(proj)).toEqual([]) // ni l'invalide ni l'homonyme ne sont proposés à l'approbation
  await m.stopAll()
})
