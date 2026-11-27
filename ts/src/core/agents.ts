/**
 * Agents CLI pilotés en mode non interactif, sortie lue ligne par ligne (aucune attente de la fin) :
 *  - Claude Code : `claude -p --output-format stream-json --verbose` (format vérifié le 26/11 sur 2.1.332) ;
 *  - Codex CLI   : `codex exec --json` / `codex exec resume ID --json` (format vérifié le 26/11 sur 0.171.0) ;
 *  - OpenCode, Gemini CLI : sortie texte simple (options lues dans leur aide ; format non vérifié par un vrai essai).
 * Chaque agent tourne dans son propre groupe de processus : Échap, un délai dépassé ou la fermeture d'Eclipse
 * l'arrêtent avec tout ce qu'il a lancé. Les clés ANTHROPIC_API_KEY / OPENAI_API_KEY ne sont pas transmises :
 * l'agent reste sur l'abonnement de l'utilisateur.
 */
import { killGroup } from "./proc"
import { agentStateDirs, available as sandboxAvailable, guard, wrap } from "./sandbox"
import { isProtected, PROTECT_RULE } from "./protect"

export type Power = "lecture" | "modifications" | "commandes" | "bypass"

/**
 * Puissance réelle d'un agent selon le mode de permission. Bypass total : tout. Bypass : tout, car l'agent sera enfermé
 * dans le projet ; sans bubblewrap rien ne peut l'y enfermer, donc modifications au plus (aucune commande automatique).
 */
export function agentPowerFor(mode: string, verified: boolean, wanted: Power): Power {
  if (mode === "lecture" || wanted === "lecture") return "lecture"
  if (mode === "bypass-total" && verified) return "bypass"
  if (mode === "bypass" && verified) return sandboxAvailable().ok ? "bypass" : "modifications"
  return wanted
}
export const POWER_LABEL: Record<Power, string> = {
  lecture: "lecture seule",
  modifications: "lecture et modifications de fichiers",
  commandes: "modifications et commandes (tests, build…)",
  bypass: "tout, sans confirmation (bypass vérifié)",
}

export type AgentEvent =
  | { type: "session"; id: string; model?: string }
  | { type: "text"; text: string; parent?: string }
  | { type: "thinking"; text: string; parent?: string }
  | { type: "tool"; id: string; name: string; summary: string; done: boolean; ok?: boolean; output?: string; parent?: string }
  | { type: "subagent"; id: string; label: string; done: boolean; ok?: boolean; output?: string; parent?: string }
  | { type: "usage"; input: number; output: number; cached?: number; costUsd?: number }
  | { type: "error"; message: string }
  | { type: "done"; interrupted?: boolean }

export interface AgentRun {
  agent: string // claude | codex | opencode | gemini
  binary: string
  cwd: string
  prompt: string
  model?: string
  effort?: string // valeur réelle de l'agent (low, medium, high…)
  power: Power
  resume?: string
  system?: string // consignes ajoutées (rôle dans /cg, mémoire)
  signal?: AbortSignal
  sandbox?: boolean
  subagents?: boolean // false : l'agent ne peut pas créer de sous-agents
  idleMs?: number // sans signe de vie (et sans commande en cours) : arrêt
  maxMs?: number
}

export const AGENT_SUPPORT: Record<string, "vérifié" | "non vérifié"> = { claude: "vérifié", codex: "vérifié", opencode: "non vérifié", gemini: "non vérifié" }

export const CLAUDE_MODELS = ["sonnet", "opus", "haiku", "fable"]
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]

export function buildCommand(r: AgentRun): string[] {
  switch (r.agent) {
    case "claude": {
      const c = [r.binary, "-p", "--output-format", "stream-json", "--verbose"]
      if (r.model) c.push("--model", r.model)
      if (r.effort) c.push("--effort", r.effort)
      if (r.resume) c.push("--resume", r.resume)
      if (r.system) c.push("--append-system-prompt", r.system)
      const sub = r.subagents !== false ? ",Agent" : ""
      if (r.power === "lecture") c.push("--tools", "Read,Grep,Glob" + sub)
      else if (r.power === "modifications") c.push("--permission-mode", "acceptEdits", "--tools", "Read,Grep,Glob,Edit,Write" + sub)
      else if (r.power === "commandes") c.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash")
      else c.push("--permission-mode", "bypassPermissions")
      if (r.subagents === false && (r.power === "commandes" || r.power === "bypass")) c.push("--disallowedTools", "Agent")
      return c
    }
    case "codex": {
      const c = r.resume ? [r.binary, "exec", "resume", r.resume, "--json", "--skip-git-repo-check"] : [r.binary, "exec", "--json", "--skip-git-repo-check"]
      if (r.model) c.push("-m", r.model)
      if (r.effort) c.push("-c", `model_reasoning_effort="${r.effort}"`)
      // bypass avec sandbox active : plus de confirmation, mais l'écriture reste limitée au projet
      if (r.power === "bypass" && !r.sandbox) c.push("--dangerously-bypass-approvals-and-sandbox")
      else c.push("-c", `sandbox_mode="${r.power === "lecture" ? "read-only" : "workspace-write"}"`, "-c", 'approval_policy="never"')
      if (r.power === "modifications") c.push("-c", "sandbox_workspace_write.network_access=false")
      c.push(r.subagents === false ? "--disable" : "--enable", "multi_agent")
      return c
    }
    case "opencode": {
      const c = [r.binary, "run"]
      if (r.model) c.push("-m", r.model)
      if (r.resume) c.push("-s", r.resume)
      if (r.power === "lecture") c.push("--agent", "plan")
      return c
    }
    case "gemini": {
      const c = [r.binary, "-o", "text"]
      if (r.model) c.push("-m", r.model)
      c.push("--approval-mode", r.power === "lecture" ? "plan" : r.power === "modifications" ? "auto_edit" : "yolo")
      return c
    }
  }
  throw new Error("agent non pris en charge : " + r.agent)
}

/** Texte envoyé à l'agent : consignes + demande (Codex et les modes texte n'ont pas d'option de consignes séparée). */
function promptFor(r: AgentRun): string {
  if (r.agent === "claude" || !r.system) return r.prompt
  return `${r.system}\n\n---\n\n${r.prompt}`
}

function summarizeClaudeTool(name: string, input: any): string {
  return String(input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.description ?? "").slice(0, 160)
}

/** Interprète une ligne de sortie ; renvoie les événements correspondants. Exporté pour les tests. */
export function parseLine(agent: string, line: string, state: { tools: Map<string, string> }): AgentEvent[] {
  if (agent !== "claude" && agent !== "codex") return line ? [{ type: "text", text: line + "\n" }] : []
  let e: any
  try {
    e = JSON.parse(line)
  } catch {
    return []
  }
  const out: AgentEvent[] = []
  if (agent === "claude") {
    if (e.type === "system" && e.subtype === "init") out.push({ type: "session", id: e.session_id, model: e.model })
    else if (e.type === "assistant") {
      const parent: string | undefined = e.parent_tool_use_id ?? undefined // message d'un sous-agent
      for (const b of e.message?.content ?? []) {
        if (b.type === "text" && b.text) out.push({ type: "text", text: b.text, parent })
        else if (b.type === "thinking" && b.thinking) out.push({ type: "thinking", text: b.thinking, parent })
        else if (b.type === "tool_use") {
          state.tools.set(b.id, b.name)
          if (b.name === "Agent" || b.name === "Task")
            out.push({ type: "subagent", id: b.id, label: String(b.input?.description ?? b.input?.subagent_type ?? "sous-agent").slice(0, 80), done: false, parent })
          else out.push({ type: "tool", id: b.id, name: b.name, summary: summarizeClaudeTool(b.name, b.input), done: false, parent })
        }
      }
    } else if (e.type === "user") {
      const parent: string | undefined = e.parent_tool_use_id ?? undefined
      for (const b of e.message?.content ?? []) {
        if (b.type === "tool_result") {
          const txt = typeof b.content === "string" ? b.content : (b.content ?? []).map((x: any) => x.text ?? "").join("\n")
          const name = state.tools.get(b.tool_use_id) ?? "outil"
          if (name === "Agent" || name === "Task") out.push({ type: "subagent", id: b.tool_use_id, label: "", done: true, ok: !b.is_error, output: txt.slice(0, 4000), parent })
          else out.push({ type: "tool", id: b.tool_use_id, name, summary: "", done: true, ok: !b.is_error, output: txt.slice(0, 4000), parent })
        }
      }
    } else if (e.type === "result") {
      const u = e.usage ?? {}
      out.push({ type: "usage", input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0,
                 cached: u.cache_read_input_tokens ?? 0, costUsd: e.total_cost_usd })
      if (e.is_error || e.subtype !== "success") out.push({ type: "error", message: `Claude Code : ${e.result || e.subtype}` })
    }
    return out
  }
  // Codex
  const it = e.item ?? {}
  if (e.type === "thread.started") out.push({ type: "session", id: e.thread_id })
  else if ((e.type === "item.started" || e.type === "item.completed") && /^collab/.test(it.type ?? "")) {
    // sous-agents de Codex (spawn_agent…) : champs lus avec tolérance, format pas encore vérifié par un vrai essai
    const label = String(it.prompt ?? it.description ?? it.tool ?? "sous-agent").replace(/\s+/g, " ").slice(0, 80)
    out.push({ type: "subagent", id: String(it.id), label, done: e.type === "item.completed", ok: it.status !== "failed" })
  } else if (e.type === "item.started" && (it.type === "command_execution" || it.type === "mcp_tool_call" || it.type === "file_change" || it.type === "web_search"))
    out.push({ type: "tool", id: it.id, name: it.type === "command_execution" ? "commande" : it.type === "file_change" ? "fichiers" : it.type, summary: String(it.command ?? it.query ?? it.tool ?? "").slice(0, 160), done: false })
  else if (e.type === "item.completed") {
    if (it.type === "agent_message" && it.text) out.push({ type: "text", text: it.text })
    else if (it.type === "reasoning" && it.text) out.push({ type: "thinking", text: it.text })
    else if (it.type === "command_execution")
      out.push({ type: "tool", id: it.id, name: "commande", summary: String(it.command ?? "").slice(0, 160), done: true, ok: it.exit_code === 0 || it.status === "completed", output: String(it.aggregated_output ?? "").slice(0, 4000) })
    else if (it.type === "file_change")
      out.push({ type: "tool", id: it.id, name: "fichiers", summary: (it.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join(", ").slice(0, 160), done: true, ok: it.status !== "failed" })
    else if (it.type === "mcp_tool_call" || it.type === "web_search")
      out.push({ type: "tool", id: it.id, name: it.type, summary: String(it.tool ?? it.query ?? ""), done: true, ok: it.status !== "failed" })
    else if (it.type === "error") out.push({ type: "error", message: `Codex : ${it.message}` })
  } else if (e.type === "turn.completed") {
    const u = e.usage ?? {}
    out.push({ type: "usage", input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cached: u.cached_input_tokens ?? 0 })
  } else if (e.type === "turn.failed") out.push({ type: "error", message: `Codex : ${e.error?.message ?? "échec du tour"}` })
  else if (e.type === "error") out.push({ type: "error", message: `Codex : ${e.message}` })
  return out
}

/** Lance l'agent et renvoie ses événements au fil de l'eau. */
export async function* runAgent(r: AgentRun): AsyncGenerator<AgentEvent> {
  if (r.power !== "lecture" && isProtected(r.cwd)) {
    yield { type: "error", message: `${r.agent} : refusé, le dossier de travail est un dossier d'Eclipse (les agents n'y écrivent jamais). Ouvrez un projet : /projet NOM.` }
    yield { type: "done" }
    return
  }
  r = { ...r, system: [r.system, PROTECT_RULE].filter(Boolean).join("\n\n") }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "POE_API_KEY"].includes(k)) env[k] = v
  env.NO_COLOR = "1"
  const cmd = buildCommand(r)
  const textMode = r.agent === "opencode" || r.agent === "gemini"
  if (r.agent === "opencode" || r.agent === "gemini") cmd.push(r.agent === "gemini" ? "-p" : "--", promptFor(r))
  // agents sans sandbox utilisable ici (Claude Code : la sienne exige socat) : enveloppés entiers dans bubblewrap
  // (projet + leurs réglages en écriture). Codex garde la sienne. Sandbox coupée : la garde (fichiers d'Eclipse en
  // lecture seule, aucune élévation de droits).
  const whole = r.sandbox && r.agent !== "codex" && sandboxAvailable().ok
  let proc: ReturnType<typeof Bun.spawn>
  try {
    const finalCmd = whole ? wrap(cmd, [r.cwd, ...agentStateDirs(r.agent)], r.cwd) : guard(cmd, r.cwd)
    proc = Bun.spawn(finalCmd, { cwd: r.cwd, env, stdin: textMode ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", detached: true })
  } catch (e) {
    yield { type: "error", message: `${r.agent} : lancement impossible (${(e as Error).message})` }
    return
  }
  if (!textMode && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(promptFor(r))
    proc.stdin.end()
  }
  const state = { tools: new Map<string, string>() }
  const running = new Set<string>()
  let last = Date.now()
  let stopReason = ""
  const stop = (why: string) => {
    if (!stopReason) stopReason = why
    killGroup(proc.pid)
  }
  const onAbort = () => stop("interrompu")
  r.signal?.addEventListener("abort", onAbort, { once: true })
  const t0 = Date.now()
  const watch = setInterval(() => {
    if (r.maxMs && Date.now() - t0 > r.maxMs) stop(`durée maximale dépassée (${Math.round(r.maxMs / 60000)} min)`)
    else if (!running.size && Date.now() - last > (r.idleMs ?? 180_000)) stop(`aucun signe de vie depuis ${Math.round((r.idleMs ?? 180_000) / 1000)} s`)
  }, 1000)
  let errTail = ""
  const errDone = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) errTail = (errTail + new TextDecoder().decode(chunk)).slice(-4000)
  })()
  const dec = new TextDecoder()
  let buf = ""
  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      last = Date.now()
      buf += dec.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        for (const ev of parseLine(r.agent, textMode ? line : line.trim(), state)) {
          if (ev.type === "tool") ev.done ? running.delete(ev.id) : running.add(ev.id)
          yield ev
        }
      }
    }
    if (buf.trim()) for (const ev of parseLine(r.agent, buf, state)) yield ev
    const code = await proc.exited
    await errDone
    if (stopReason) {
      if (stopReason !== "interrompu") yield { type: "error", message: `${r.agent} arrêté : ${stopReason}` }
      yield { type: "done", interrupted: stopReason === "interrompu" }
      return
    }
    if (code !== 0) {
      const lines = errTail.split("\n").map((l) => l.trim()).filter((l) => l && !/rmcp::transport|ERROR rmcp|bb-mcp/.test(l)) // bruit de serveurs MCP de l'utilisateur
      yield { type: "error", message: `${r.agent} a quitté avec le code ${code}${lines.length ? " : " + lines.slice(-3).join(" · ").slice(0, 400) : ""}` }
    }
    yield { type: "done" }
  } finally {
    clearInterval(watch)
    r.signal?.removeEventListener("abort", onAbort)
    killGroup(proc.pid)
  }
}

export interface AgentModel {
  id: string
  efforts: string[]
  defaultEffort?: string
}

/** Modèles proposés par un agent installé : catalogue local de Codex (`codex debug models`), alias de Claude Code. */
export async function agentModels(agent: string, binary: string): Promise<AgentModel[]> {
  if (agent === "claude") return CLAUDE_MODELS.map((id) => ({ id, efforts: CLAUDE_EFFORTS }))
  if (agent === "codex") {
    const { runCmd } = await import("./proc")
    const r = await runCmd([binary, "debug", "models"], { timeoutMs: 30_000 })
    try {
      const d = JSON.parse(r.out)
      const ms: any[] = Array.isArray(d) ? d : d.models ?? []
      return ms.filter((m) => m.visibility !== "hide" && m.slug).map((m) => ({
        id: m.slug, defaultEffort: m.default_reasoning_level,
        efforts: (m.supported_reasoning_levels ?? []).map((x: any) => (typeof x === "string" ? x : x.effort)).filter(Boolean),
      }))
    } catch {
      return []
    }
  }
  return []
}
