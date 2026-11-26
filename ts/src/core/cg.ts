/**
 * /cg : Claude Code et Codex travaillent ensemble sur une seule demande (pratiques publiées, recherche du 26/11) :
 *  1. tri par le coordinateur, en lecture seule : une question ou une petite demande reçoit une réponse directe ;
 *  2. sinon le coordinateur désigne UN agent qui écrit (selon les forces de chacun) et ce que l'autre doit vérifier ;
 *  3. l'agent désigné travaille ; l'autre ne peut que lire (ses propres options de lecture seule) ;
 *  4. l'autre relit le diff réel et conclut « VERDICT: APPROUVÉ » ou « VERDICT: À REVOIR » avec fichier et ligne ;
 *  5. à revoir : l'agent qui écrit corrige (même session), 3 tours au plus ; ensuite le désaccord est présenté ;
 *  6. un résultat unique est rendu, composé par Eclipse (pas d'appel en plus).
 * Si l'un des deux agents manque, /cg continue avec celui qui est là, sans relecture croisée, et le dit.
 */
import { runAgent as defaultRun, type AgentEvent, type AgentRun, type Power } from "./agents"

export type CgAgent = "claude" | "codex"
export const CG_LABEL: Record<CgAgent, string> = { claude: "Claude Code", codex: "Codex" }
export const MAX_ROUNDS = 3

export interface CgAgentConfig {
  binary: string
  model?: string
  effort?: string
  power: Power // puissance maximale de l'agent quand c'est lui qui écrit
}

export type CgStatus = "en attente" | "coordonne" | "travaille" | "relit" | "corrige" | "terminé" | "échec" | "absent"

export interface CgCallbacks {
  phase: (text: string) => void
  status: (agent: CgAgent, s: CgStatus) => void
  event: (agent: CgAgent, e: AgentEvent) => void
}

export interface Plan {
  simple: boolean
  answer?: string
  writer: CgAgent
  task: string
  review: string
}

/** Façon de travailler : le coordinateur décide, fait tout seul, ou délègue l'écriture à l'autre agent. */
export type CgMode = "auto" | "seul" | "delegue"
export const CG_MODE_LABEL: Record<CgMode, string> = {
  auto: "le coordinateur décide qui écrit",
  seul: "le coordinateur fait le travail lui-même",
  delegue: "le coordinateur délègue l'écriture à l'autre agent",
}

export interface CgTurnOptions {
  text: string
  cwd: string
  agents: Partial<Record<CgAgent, CgAgentConfig>>
  lead: CgAgent
  sessions: Partial<Record<CgAgent, string>>
  memory?: string // mémoire du projet à transmettre
  mode?: CgMode
  review?: boolean // relecture par l'autre agent (défaut : oui)
  subagents?: boolean // sous-agents autorisés (défaut : oui)
  sandbox?: boolean
  signal?: AbortSignal
  snapshot?: (label: string) => Promise<string | null>
  diff?: (a: string, b: string) => Promise<string>
  run?: (r: AgentRun) => AsyncGenerator<AgentEvent>
}

export interface CgResult {
  markdown: string
  plan?: Plan
  rounds: number
  verdict?: "approuvé" | "à revoir" | "sans relecture"
  usage: Partial<Record<CgAgent, { input: number; output: number; costUsd?: number }>>
  interrupted: boolean
  wrote: boolean
}

const ROLE = (me: CgAgent, other: CgAgent | null) =>
  `Tu travailles dans Eclipse /cg${other ? ` avec ${CG_LABEL[other]}` : ""}. Eclipse coordonne les échanges : n'appelle jamais l'autre agent toi-même, ` +
  "n'étends pas la demande de l'utilisateur, réponds en français."

/** Lit le JSON du plan même entouré de texte ou d'un bloc ```json. */
export function parsePlan(text: string, agents: CgAgent[], lead: CgAgent): Plan | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const writer: CgAgent = agents.includes(j.writer) ? j.writer : lead
    if (j.simple === true) return { simple: true, answer: String(j.answer ?? "").trim(), writer, task: "", review: "" }
    const task = String(j.task ?? "").trim()
    if (!task) return null
    return { simple: false, writer, task, review: String(j.review ?? "").trim() }
  } catch {
    return null
  }
}

export function verdictOf(text: string): "approuvé" | "à revoir" | null {
  const m = text.match(/VERDICT\s*:\s*(APPROUV[ÉE]|[ÀA]\s*REVOIR)/i)
  if (!m) return null
  return /APPROUV/i.test(m[1]) ? "approuvé" : "à revoir"
}

export async function cgTurn(o: CgTurnOptions, cb: CgCallbacks): Promise<CgResult> {
  const run = o.run ?? defaultRun
  const present = (Object.keys(o.agents) as CgAgent[]).filter((a) => o.agents[a])
  const usage: CgResult["usage"] = {}
  let interrupted = false
  const lead: CgAgent = present.includes(o.lead) ? o.lead : present[0]
  for (const a of ["claude", "codex"] as CgAgent[]) cb.status(a, present.includes(a) ? "en attente" : "absent")

  /** Un appel d'agent ; renvoie son texte final (les événements partent en direct vers l'écran). */
  async function call(agent: CgAgent, prompt: string, power: Power, status: CgStatus, otherName: CgAgent | null): Promise<{ text: string; failed: boolean }> {
    const cfg = o.agents[agent]!
    cb.status(agent, status)
    let text = ""
    let failed = false
    for await (const e of run({ agent, binary: cfg.binary, cwd: o.cwd, prompt, model: cfg.model, effort: cfg.effort, power, resume: o.sessions[agent], subagents: o.subagents,
                                system: [ROLE(agent, otherName), o.memory].filter(Boolean).join("\n\n"), signal: o.signal, sandbox: o.sandbox, idleMs: 180_000 })) {
      cb.event(agent, e)
      if (e.type === "session") o.sessions[agent] = e.id
      else if (e.type === "text") text += (text ? "\n\n" : "") + e.text
      else if (e.type === "usage") {
        const u = (usage[agent] ??= { input: 0, output: 0 })
        u.input += e.input
        u.output += e.output
        if (e.costUsd != null) u.costUsd = (u.costUsd ?? 0) + e.costUsd
      } else if (e.type === "error") failed = true
      else if (e.type === "done" && e.interrupted) interrupted = true
    }
    cb.status(agent, failed ? "échec" : interrupted ? "en attente" : "terminé")
    return { text, failed }
  }

  const base = { usage, interrupted: false, rounds: 0, wrote: false }
  if (!present.length) return { ...base, markdown: "Ni Claude Code ni Codex ne sont installés : /cg ne peut pas démarrer." }
  const other = (a: CgAgent): CgAgent | null => present.find((x) => x !== a) ?? null

  const mode: CgMode = o.mode ?? "auto"
  const wantReview = o.review !== false
  let plan: Plan | null
  if (mode === "seul") {
    // le coordinateur fait tout lui-même : pas d'appel de tri, la demande lui est transmise telle quelle
    plan = { simple: false, writer: lead, task: o.text, review: "" }
  } else {
  // 1-2. tri et répartition par le coordinateur, en lecture seule
  cb.phase(`${CG_LABEL[lead]} coordonne : tri de la demande`)
  const planPrompt = `Demande de l'utilisateur :\n${o.text}\n\n` +
    `Tu coordonnes ${present.length > 1 ? "deux agents : toi (" + lead + ") et " + other(lead) : "un seul agent : toi (" + lead + ")"}. Examine le projet si besoin, en lecture seule.\n` +
    "Réponds UNIQUEMENT par un objet JSON, sans texte autour :\n" +
    '{"simple": true, "answer": "ta réponse complète en Markdown"}  si c\'est une question, une explication ou une demande sans modification de fichiers ;\n' +
    `{"simple": false, "writer": "${present.join('" ou "')}", "task": "consigne précise et complète pour l'agent qui modifie", "review": "ce que l'autre doit vérifier en priorité"}  sinon.\n` +
    (mode === "delegue" && other(lead) ? `Le travail sera fait par ${CG_LABEL[other(lead)!]} : écris-lui une consigne précise (writer = "${other(lead)}").`
      : "Choisis l'agent qui écrit selon ses forces : Claude Code pour la conception, la refonte et le raisonnement sur tout le projet ; Codex pour l'implémentation ciblée, les scripts et les tests. Un seul agent écrit.")
  const p = await call(lead, planPrompt, "lecture", "coordonne", other(lead))
  if (interrupted) return { ...base, interrupted: true, markdown: "Échange interrompu." }
  if (p.failed && !p.text) return { ...base, markdown: `${CG_LABEL[lead]} n'a pas pu coordonner (voir sa zone).` }
  plan = parsePlan(p.text, present, lead)
  if (plan && !plan.simple && mode === "delegue" && other(lead)) plan.writer = other(lead)! // délégation imposée par le réglage
  if (!plan) {
    // réponse non structurée : elle est rendue telle quelle plutôt que perdue
    return { ...base, markdown: p.text || "Pas de réponse du coordinateur.", verdict: "sans relecture" }
  }
  if (plan.simple) {
    cb.phase("Réponse directe (demande simple : pas de boucle)")
    return { ...base, plan, markdown: plan.answer || p.text, verdict: "sans relecture" }
  }
  }

  // 3. l'agent désigné écrit, seul
  const writer = plan.writer
  const reviewer = wantReview ? other(writer) : null
  const before = (await o.snapshot?.(`cg avant : ${o.text.slice(0, 50)}`)) ?? null
  cb.phase(`${CG_LABEL[writer]} travaille${reviewer ? ` · ${CG_LABEL[reviewer]} relira` : " (seul : pas de relecture croisée)"}`)
  const writerPower: Power = o.agents[writer]!.power === "lecture" ? "lecture" : o.agents[writer]!.power
  let report = await call(writer, `Demande de l'utilisateur :\n${o.text}\n\n${mode === "seul" ? "" : `Consigne du coordinateur :\n${plan.task}\n\n`}` +
    "Tu es le seul à modifier les fichiers. Termine par un court rapport : fichiers modifiés, commandes ou tests lancés, résultat, ce qui reste.", writerPower, "travaille", reviewer)
  if (interrupted) return { ...base, plan, interrupted: true, markdown: "Échange interrompu pendant le travail. /undo pour annuler les fichiers déjà modifiés." }
  if (!reviewer) return { ...base, plan, wrote: true, verdict: "sans relecture",
                          markdown: `## Résultat (${CG_LABEL[writer]}, sans relecture : ${wantReview ? "l'autre agent est absent" : "relecture désactivée"})\n\n${report.text}` }

  // 4-5. relecture du diff réel par l'autre, corrections bornées
  let verdict: "approuvé" | "à revoir" | null = null
  let review = ""
  let rounds = 0
  while (rounds < MAX_ROUNDS) {
    rounds++
    const after = (await o.snapshot?.(`cg après tour ${rounds}`)) ?? null
    const diff = before && after && o.diff ? await o.diff(before, after) : ""
    cb.phase(`${CG_LABEL[reviewer]} relit (tour ${rounds}/${MAX_ROUNDS})`)
    const r = await call(reviewer, `Demande de l'utilisateur :\n${o.text}\n\n${CG_LABEL[writer]} a fait ce travail. Son rapport :\n${report.text}\n\n` +
      (diff ? `Changements réels dans le projet :\n\`\`\`diff\n${diff}\n\`\`\`\n\n` : "Aucun fichier modifié n'a été détecté.\n\n") +
      `Point à vérifier en priorité : ${plan.review || "la justesse et les tests"}.\nTu ne modifies rien. Donne chaque problème avec fichier et ligne, du plus grave au moins grave. ` +
      "Termine par une ligne exactement : « VERDICT: APPROUVÉ » ou « VERDICT: À REVOIR ».", "lecture", "relit", writer)
    if (interrupted) return { ...base, plan, rounds, wrote: !!diff, interrupted: true, markdown: "Échange interrompu pendant la relecture." }
    review = r.text
    verdict = verdictOf(r.text)
    if (verdict !== "à revoir") break
    if (rounds >= MAX_ROUNDS) break
    cb.phase(`${CG_LABEL[writer]} corrige (tour ${rounds + 1}/${MAX_ROUNDS})`)
    report = await call(writer, `${CG_LABEL[reviewer]} a relu ton travail et demande des corrections :\n${r.text}\n\n` +
      "Corrige ce qui est justifié (explique ce que tu refuses et pourquoi), puis refais ton court rapport.", writerPower, "corrige", reviewer)
    if (interrupted) return { ...base, plan, rounds, interrupted: true, markdown: "Échange interrompu pendant les corrections." }
  }
  const after = (await o.snapshot?.("cg fin")) ?? null
  const wrote = !!(before && after && o.diff && (await o.diff(before, after)).trim())
  const head = verdict === "approuvé" ? `Relu et approuvé par ${CG_LABEL[reviewer]}` :
               verdict === "à revoir" ? `Désaccord après ${rounds} tour(s) : ${CG_LABEL[reviewer]} demande encore des corrections — à vous de trancher` :
               `${CG_LABEL[reviewer]} n'a pas donné de verdict clair`
  cb.phase(head)
  return { ...base, plan, rounds, wrote, verdict: verdict ?? "à revoir",
           markdown: `## Résultat — ${head}\n\n### Travail (${CG_LABEL[writer]})\n${report.text}\n\n### Relecture (${CG_LABEL[reviewer]})\n${review}` }
}
