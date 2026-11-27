import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCommand, parseLine, runAgent, type AgentEvent } from "../src/core/agents"

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "eclipse-agents-"))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const parseAll = (agent: string, file: string) => {
  const st = { tools: new Map<string, string>() }
  return readFileSync(join(import.meta.dir, "fixtures", file), "utf8").split("\n").flatMap((l) => parseLine(agent, l.trim(), st))
}

test("sortie réelle de Claude Code 2.1.332 : session, texte, consommation", () => {
  const ev = parseAll("claude", "claude-2.1.332.jsonl")
  expect(ev[0]).toMatchObject({ type: "session", model: "claude-haiku-5-5" })
  expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "ok" })
  expect(ev.find((e) => e.type === "usage")).toMatchObject({ type: "usage", output: 4 })
  expect(ev.some((e) => e.type === "error")).toBe(false)
})

test("sortie réelle de Codex 0.171.0 : discussion, message, consommation", () => {
  const ev = parseAll("codex", "codex-0.171.0.jsonl")
  expect(ev[0]).toEqual({ type: "session", id: "01a21533-a997-77f3-a820-2b7012620e41" })
  expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "ok" })
  expect(ev.find((e) => e.type === "usage")).toMatchObject({ input: 19949, output: 5, cached: 11648 })
})

test("puissance traduite en options réelles de chaque agent", () => {
  const c = (agent: string, power: any, extra = {}) => buildCommand({ agent, binary: agent, cwd: ".", prompt: "x", power, ...extra }).join(" ")
  expect(c("claude", "lecture")).toContain("--tools Read,Grep,Glob")
  expect(c("claude", "modifications")).toContain("--permission-mode acceptEdits")
  expect(c("claude", "bypass")).toContain("bypassPermissions")
  expect(c("claude", "lecture", { model: "haiku", effort: "low", resume: "abc" })).toContain("--model haiku --effort low --resume abc")
  expect(c("codex", "lecture")).toContain('sandbox_mode="read-only"')
  expect(c("codex", "commandes")).toContain('sandbox_mode="workspace-write"')
  expect(c("codex", "bypass")).toContain("--dangerously-bypass-approvals-and-sandbox")
  expect(c("codex", "lecture", { resume: "t1" })).toStartWith("codex exec resume t1 --json")
  expect(c("gemini", "lecture")).toContain("--approval-mode plan")
})

function fakeAgent(script: string): string {
  const p = join(dir, "faux-agent")
  writeFileSync(p, "#!/bin/sh\n" + script)
  chmodSync(p, 0o755)
  return p
}

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

test("lecture au fil de l'eau, outils suivis, code de sortie expliqué", async () => {
  const bin = fakeAgent(`cat > /dev/null
echo '{"type":"system","subtype":"init","session_id":"s1","model":"m"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a.txt"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"fini"}]}}'
echo 'boum' >&2
exit 2`)
  const ev = await collect(runAgent({ agent: "claude", binary: bin, cwd: dir, prompt: "x", power: "lecture" }))
  expect(ev.map((e) => e.type)).toEqual(["session", "tool", "tool", "text", "error", "done"])
  expect(ev[2]).toMatchObject({ done: true, ok: true, name: "Bash", output: "a.txt" })
  expect((ev[4] as any).message).toBe("claude a quitté avec le code 2 : boum")
})

test("agent muet arrêté (et ses enfants), Échap interrompt proprement", async () => {
  const bin = fakeAgent("cat > /dev/null\n/bin/sleep 60 &\n/bin/sleep 60\n")
  const t0 = Date.now()
  const ev = await collect(runAgent({ agent: "claude", binary: bin, cwd: dir, prompt: "x", power: "lecture", idleMs: 1200 }))
  expect(Date.now() - t0).toBeLessThan(6000)
  expect((ev[0] as any).message).toContain("aucun signe de vie")
  expect(Bun.spawnSync(["pgrep", "-f", "^/bin/sleep 60$"]).stdout.toString().trim()).toBe("") // motif ancré : ne reconnaît pas la ligne de commande du test lui-même
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const ev2 = await collect(runAgent({ agent: "claude", binary: bin, cwd: dir, prompt: "x", power: "lecture", signal: ac.signal }))
  expect(ev2).toEqual([{ type: "done", interrupted: true }])
})

test("les clés d'API ne sont pas transmises à l'agent", async () => {
  process.env.ANTHROPIC_API_KEY = "ne-doit-pas-passer"
  const bin = fakeAgent('cat > /dev/null\necho "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"cle=${ANTHROPIC_API_KEY:-absente}\\"}]}}"')
  const ev = await collect(runAgent({ agent: "claude", binary: bin, cwd: dir, prompt: "x", power: "lecture" }))
  delete process.env.ANTHROPIC_API_KEY
  expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "cle=absente" })
})

test("sous-agents de Claude Code : création, messages rattachés (parent_tool_use_id), fin", () => {
  const st = { tools: new Map<string, string>() }
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Explorer les tests", subagent_type: "Explore" } }] } },
    { type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "text", text: "Je cherche." }, { type: "tool_use", id: "g1", name: "Grep", input: { pattern: "test" } }] } },
    { type: "user", parent_tool_use_id: "a1", message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "3 fichiers" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "Rapport du sous-agent" }] } },
  ]
  const ev = lines.flatMap((l) => parseLine("claude", JSON.stringify(l), st))
  expect(ev[0]).toEqual({ type: "subagent", id: "a1", label: "Explorer les tests", done: false, parent: undefined })
  expect(ev[1]).toMatchObject({ type: "text", text: "Je cherche.", parent: "a1" })
  expect(ev[2]).toMatchObject({ type: "tool", name: "Grep", parent: "a1", done: false })
  expect(ev[3]).toMatchObject({ type: "tool", done: true, parent: "a1" })
  expect(ev[4]).toMatchObject({ type: "subagent", id: "a1", done: true, ok: true, output: "Rapport du sous-agent" })
})

test("sous-agents autorisés ou non, dans les options réelles", () => {
  const c = (agent: string, power: any, subagents?: boolean) => buildCommand({ agent, binary: agent, cwd: ".", prompt: "x", power, subagents }).join(" ")
  expect(c("claude", "modifications")).toContain("Read,Grep,Glob,Edit,Write,Agent")
  expect(c("claude", "modifications", false)).not.toContain("Agent")
  expect(c("claude", "commandes", false)).toContain("--disallowedTools Agent")
  expect(c("codex", "modifications")).toContain("--enable multi_agent")
  expect(c("codex", "modifications", false)).toContain("--disable multi_agent")
})

test("garde : un agent sans sandbox, même en bypass, ne peut pas écrire dans les fichiers d'Eclipse", async () => {
  if (process.platform !== "linux" || !Bun.which("bwrap")) {
    if (process.env.ECLIPSE_REQUIRE_BWRAP === "1") throw new Error("bubblewrap requis pour ce test (ECLIPSE_REQUIRE_BWRAP=1)")
    return
  }
  const prev = process.env.ECLIPSE_ROOT
  const eclipse = join(dir, "installation-eclipse")
  mkdirSync(eclipse)
  process.env.ECLIPSE_ROOT = eclipse // dossier protégé de plus pour ce test
  const proj = join(dir, "projet")
  mkdirSync(proj)
  const bin = fakeAgent(`cat > /dev/null
echo dedans > "${proj}/ok.txt"
echo x > "${eclipse}/pirate.txt" 2>/dev/null || echo '{"type":"assistant","message":{"content":[{"type":"text","text":"refusé"}]}}'
echo '{"type":"result","subtype":"success","result":"fini"}'`)
  try {
    const ev = await collect(runAgent({ agent: "claude", binary: bin, cwd: proj, prompt: "x", power: "bypass", sandbox: false }))
    expect(existsSync(join(proj, "ok.txt"))).toBe(true)
    expect(existsSync(join(eclipse, "pirate.txt"))).toBe(false)
    expect(ev.some((e) => e.type === "text" && (e as any).text.includes("refusé"))).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.ECLIPSE_ROOT
    else process.env.ECLIPSE_ROOT = prev
  }
})

test("puissance des agents : bypass total = tout ; bypass = tout seulement s'ils peuvent être enfermés", async () => {
  const { agentPowerFor } = await import("../src/core/agents")
  const { available } = await import("../src/core/sandbox")
  expect(agentPowerFor("bypass-total", true, "modifications")).toBe("bypass")
  expect(agentPowerFor("bypass", true, "commandes")).toBe(available().ok ? "bypass" : "modifications")
  expect(agentPowerFor("bypass", false, "commandes")).toBe("commandes") // bypass non vérifié : réglage de l'agent
  expect(agentPowerFor("lecture", true, "commandes")).toBe("lecture")
  expect(agentPowerFor("bypass-total", true, "lecture")).toBe("lecture") // mode plan
  expect(agentPowerFor("bypass", true, "commandes", "opencode")).toBe(available().ok ? "bypass" : "lecture")
})
