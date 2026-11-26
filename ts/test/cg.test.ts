import { expect, test } from "bun:test"
import type { AgentEvent, AgentRun } from "../src/core/agents"
import { cgTurn, parsePlan, verdictOf, type CgAgent, type CgCallbacks } from "../src/core/cg"

/** Faux agents : chaque appel reçoit la réponse suivante de sa file ; les appels sont journalisés. */
function fakeRun(script: Record<string, string[]>, log: AgentRun[]) {
  return async function* (r: AgentRun): AsyncGenerator<AgentEvent> {
    log.push(r)
    yield { type: "session", id: `${r.agent}-s` }
    const t = script[r.agent].shift() ?? ""
    if (t) yield { type: "text", text: t }
    yield { type: "usage", input: 10, output: 5 }
    yield { type: "done" }
  }
}

const cb = (phases: string[] = [], statuses: string[] = []): CgCallbacks => ({
  phase: (p) => phases.push(p), status: (a, s) => statuses.push(`${a}:${s}`), event: () => {},
})
const agents = { claude: { binary: "claude", power: "modifications" as const }, codex: { binary: "codex", power: "commandes" as const } }

test("plan lu même entouré de texte ; verdict reconnu", () => {
  expect(parsePlan('Voici :\n```json\n{"simple": false, "writer": "codex", "task": "Ajoute un test", "review": "cas limites"}\n```', ["claude", "codex"], "claude"))
    .toEqual({ simple: false, writer: "codex", task: "Ajoute un test", review: "cas limites" })
  expect(parsePlan('{"simple": true, "answer": "42"}', ["claude"], "claude")).toMatchObject({ simple: true, answer: "42" })
  expect(parsePlan("pas de json", ["claude"], "claude")).toBeNull()
  expect(verdictOf("ok\nVERDICT: APPROUVÉ")).toBe("approuvé")
  expect(verdictOf("VERDICT : à revoir")).toBe("à revoir")
  expect(verdictOf("rien")).toBeNull()
})

test("demande simple : un seul appel, en lecture seule, pas de boucle", async () => {
  const log: AgentRun[] = []
  const r = await cgTurn({ text: "salut", cwd: ".", agents, lead: "claude", sessions: {}, run: fakeRun({ claude: ['{"simple": true, "answer": "Bonjour !"}'], codex: [] }, log) }, cb())
  expect(log.length).toBe(1)
  expect(log[0].power).toBe("lecture")
  expect(r.markdown).toBe("Bonjour !")
})

test("travail : un seul écrit, l'autre relit en lecture seule le diff réel, puis approuve", async () => {
  const log: AgentRun[] = []
  const phases: string[] = []
  let n = 0
  const r = await cgTurn({
    text: "ajoute un test", cwd: ".", agents, lead: "claude", sessions: {},
    snapshot: async () => `snap${++n}`, diff: async (a, b) => (a === b ? "" : "+test()"),
    run: fakeRun({ claude: ['{"simple": false, "writer": "codex", "task": "Écris le test", "review": "cas limites"}', "Relu.\nVERDICT: APPROUVÉ"], codex: ["Test ajouté."] }, log),
  }, cb(phases))
  expect(log.map((x) => `${x.agent}:${x.power}`)).toEqual(["claude:lecture", "codex:commandes", "claude:lecture"])
  expect(log[2].prompt).toContain("+test()")
  expect(r.verdict).toBe("approuvé")
  expect(r.markdown).toContain("Relu et approuvé par Claude Code")
  expect(r.markdown).toContain("Test ajouté.")
  expect(log.filter((x) => x.power !== "lecture").map((x) => x.agent)).toEqual(["codex"]) // un seul agent écrit
})

test("à revoir : correction dans la même session, 3 tours au plus, désaccord présenté", async () => {
  const log: AgentRun[] = []
  const sessions: Partial<Record<CgAgent, string>> = {}
  const r = await cgTurn({
    text: "refais le module", cwd: ".", agents, lead: "codex", sessions,
    run: fakeRun({ codex: ['{"simple": false, "writer": "claude", "task": "Refais", "review": "API"}', "VERDICT: À REVOIR", "VERDICT: À REVOIR", "VERDICT: À REVOIR"],
                   claude: ["v1", "v2", "v3"] }, log),
  }, cb())
  expect(r.rounds).toBe(3)
  expect(r.verdict).toBe("à revoir")
  expect(r.markdown).toContain("à vous de trancher")
  const claudeCalls = log.filter((x) => x.agent === "claude")
  expect(claudeCalls.length).toBe(3)
  expect(claudeCalls[1].resume).toBe("claude-s") // la correction reprend la session de l'agent
})

test("Codex absent : Claude Code seul, sans relecture croisée, et c'est dit", async () => {
  const log: AgentRun[] = []
  const statuses: string[] = []
  const r = await cgTurn({ text: "corrige", cwd: ".", agents: { claude: agents.claude }, lead: "codex", sessions: {},
    run: fakeRun({ claude: ['{"simple": false, "writer": "claude", "task": "Corrige"}', "Corrigé."], codex: [] }, log) }, cb([], statuses))
  expect(statuses).toContain("codex:absent")
  expect(r.verdict).toBe("sans relecture")
  expect(r.markdown).toContain("l'autre agent est absent")
})

test("interruption : tout s'arrête, rien n'est lancé ensuite", async () => {
  const log: AgentRun[] = []
  const run = async function* (r: AgentRun): AsyncGenerator<AgentEvent> {
    log.push(r)
    yield { type: "done", interrupted: true }
  }
  const r = await cgTurn({ text: "x", cwd: ".", agents, lead: "claude", sessions: {}, run }, cb())
  expect(r.interrupted).toBe(true)
  expect(log.length).toBe(1)
})

test("« seul » : pas de tri, le coordinateur écrit, l'autre relit ; relecture désactivable", async () => {
  const log: AgentRun[] = []
  const r = await cgTurn({ text: "corrige", cwd: ".", agents, lead: "codex", sessions: {}, mode: "seul",
    run: fakeRun({ codex: ["Corrigé."], claude: ["VERDICT: APPROUVÉ"] }, log) }, cb())
  expect(log.map((x) => `${x.agent}:${x.power}`)).toEqual(["codex:commandes", "claude:lecture"])
  expect(r.verdict).toBe("approuvé")
  const log2: AgentRun[] = []
  const r2 = await cgTurn({ text: "corrige", cwd: ".", agents, lead: "codex", sessions: {}, mode: "seul", review: false,
    run: fakeRun({ codex: ["Corrigé."], claude: [] }, log2) }, cb())
  expect(log2.length).toBe(1)
  expect(r2.markdown).toContain("relecture désactivée")
})

test("« délègue » : l'écriture va à l'autre agent même si le plan en choisit un autre ; sous-agents transmis", async () => {
  const log: AgentRun[] = []
  await cgTurn({ text: "ajoute", cwd: ".", agents, lead: "claude", sessions: {}, mode: "delegue", subagents: false,
    run: fakeRun({ claude: ['{"simple": false, "writer": "claude", "task": "Ajoute"}', "VERDICT: APPROUVÉ"], codex: ["Ajouté."] }, log) }, cb())
  expect(log.map((x) => x.agent)).toEqual(["claude", "codex", "claude"])
  expect(log.every((x) => x.subagents === false)).toBe(true)
})
