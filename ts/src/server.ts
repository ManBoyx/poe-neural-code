/**
 * Moteur du desktop (Eclipse 5) : `eclipse-engine serve [--watch-stdin] [--port N]`.
 * Écoute sur 127.0.0.1 uniquement, avec un jeton aléatoire ; annonce {"event":"ready","port","token"} sur la sortie
 * (protocole attendu par l'application Tauri) ; s'arrête quand son entrée se ferme (--watch-stdin).
 * Même moteur et mêmes données que le terminal (mémoire, sessions, consommation, clés, MCP, projets).
 */
import { randomBytes } from "node:crypto"
import { Budget, dayStart, monthStart, tokens, weekStart } from "./core/budget"
import { poeBalance, provider, PROVIDERS, verifyKey } from "./core/providers"
import { setKey } from "./core/secrets"
import { verifyPassword } from "./core/auth"
import { needsProject } from "./core/protect"
import * as V from "./core/voice"
import { EngineSession, type EngineEvent, type Space } from "./engine/session"
import { approveFingerprint, pendingProject, revoke } from "./core/mcp"

const args = process.argv.slice(2)
if (args[0] !== "serve") {
  console.error("usage : eclipse-engine serve [--watch-stdin] [--port N] [--dir DOSSIER]")
  process.exit(2)
}
const portArg = Number(args[args.indexOf("--port") + 1]) || 0
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : process.cwd()
const token = randomBytes(24).toString("hex")

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const enc = new TextEncoder()
function broadcast(e: EngineEvent | { type: string; [k: string]: unknown }) {
  const data = enc.encode(`data: ${JSON.stringify(e)}\n\n`)
  for (const c of clients) {
    try {
      c.enqueue(data)
    } catch {
      clients.delete(c)
    }
  }
}

const S = new EngineSession(dir, (e) => broadcast(e))
S.init()

// ------------------------------------------------------------------ voix : dictée et appel
let call: { stop: () => void; pause: (on: boolean) => void } | null = null
let stopSpeech: (() => void) | null = null
function voiceState(state: string, extra: Record<string, unknown> = {}) {
  broadcast({ type: "voice", state, ...extra })
}
async function dictate(): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const s = V.setup()
  if (s.missing.length) return { ok: false, reason: s.missing.join(" ; ") }
  return new Promise((res) => {
    voiceState("écoute")
    let done = false
    const l = V.listen(s, {
      onUtterance: async (pcm) => {
        if (done) return
        done = true
        l.stop()
        voiceState("transcription")
        const r = await V.transcribe(s, pcm)
        voiceState("")
        res(r.ok ? { ok: true, text: r.text } : { ok: false, reason: r.reason })
      },
      onLevel: (level) => broadcast({ type: "voice-level", level }),
      onError: (m) => { if (!done) { done = true; voiceState(""); res({ ok: false, reason: m }) } },
    })
    setTimeout(() => { if (!done) { done = true; l.stop(); voiceState(""); res({ ok: false, reason: "rien entendu en 30 s" }) } }, 30_000)
  })
}
function startCall(space: Space, cg: boolean) {
  const s = V.setup()
  if (s.missing.length) return { ok: false, reason: s.missing.join(" ; ") }
  voiceState("écoute", { call: true })
  call = V.listen(s, {
    onUtterance: async (pcm) => {
      call?.pause(true)
      voiceState("transcription", { call: true })
      const r = await V.transcribe(s, pcm)
      if (!call) return
      if (!r.ok || !r.text || r.text.length < 2) {
        voiceState("écoute", { call: true })
        return call.pause(false)
      }
      if (/^(raccroche|fin de l'appel|au revoir)\.?$/i.test(r.text.trim())) return endCall()
      broadcast({ type: "voice-text", text: r.text })
      voiceState("réponse", { call: true })
      let answer = ""
      const off = (e: EngineEvent) => { if (e.type === "done") answer = e.text }
      const prev = S.emit
      S.emit = (e) => { off(e); prev(e) }
      try {
        await S.send(r.text, space, { cg })
      } catch (e) {
        broadcast({ type: "notice", text: (e as Error).message, level: "error" })
      }
      S.emit = prev
      if (!call) return
      voiceState("lecture", { call: true })
      stopSpeech = V.speak(s, V.speakable(answer || "Pas de réponse à lire."), () => {
        stopSpeech = null
        if (!call) return
        voiceState("écoute", { call: true })
        call.pause(false)
      })
    },
    onLevel: (level) => broadcast({ type: "voice-level", level }),
    onError: (m) => { broadcast({ type: "notice", text: `Appel arrêté : ${m}`, level: "error" }); endCall() },
  })
  return { ok: true }
}
function endCall() {
  call?.stop()
  call = null
  stopSpeech?.()
  stopSpeech = null
  voiceState("", { call: false })
}

// ------------------------------------------------------------------ HTTP
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...cors } })
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" }
const usageBudget = new Budget()

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: portArg,
  idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    if (req.method === "OPTIONS") return new Response(null, { headers: cors })
    const auth = req.headers.get("authorization") === `Bearer ${token}` || u.searchParams.get("token") === token
    if (!auth) return json({ error: "jeton manquant ou faux" }, 401)
    const body = async () => (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as any
    const p = u.pathname
    try {
      if (p === "/api/events") {
        let ctl!: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
          start(c) { ctl = c; clients.add(c); c.enqueue(enc.encode(": eclipse\n\n")) },
          cancel() { clients.delete(ctl) },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors } })
      }
      if (p === "/api/state") return json(S.state())
      if (p === "/api/models") {
        return json({
          recents: S.st.recents.slice(0, 8),
          providers: PROVIDERS.map((pv) => ({ id: pv.id, label: pv.label, recommended: !!pv.recommended, local: !!pv.local, key: S.keyState[pv.id] ?? "…",
            models: (S.models[pv.id] ?? []).map((m) => ({ id: m.id, free: !!m.free, priceIn: m.priceIn, priceOut: m.priceOut, context: m.context, tools: m.tools, effort: m.effort, output: m.output })) })),
          agents: S.state().agents,
        })
      }
      if (p === "/api/choose") return (S.choose(await body()), json(S.state()))
      if (p === "/api/effort") {
        const b = await body()
        const c = S.st.current
        if (!c) return json({ error: "aucun modèle" }, 400)
        const eff = { ...(S.st.prefs.effort ?? {}) }
        if (!b.value) delete eff[`${c.provider}/${c.model ?? ""}`]
        else eff[`${c.provider}/${c.model ?? ""}`] = b.value
        S.savePrefs({ effort: eff })
        return json(S.state())
      }
      if (p === "/api/key") {
        const b = await body()
        const pv = provider(b.provider)
        if (!pv || !b.key) return json({ error: "fournisseur ou clé manquant" }, 400)
        const v = await verifyKey(pv, { key: String(b.key) })
        if (v.check === "refusée") return json({ ok: false, message: `${pv.label} refuse cette clé` })
        const r = await setKey(pv.id, String(b.key))
        if (r.ok) S.loadProvider(pv.id)
        return json({ ok: r.ok, message: r.ok ? "Clé vérifiée et enregistrée dans le trousseau" : r.message })
      }
      if (p === "/api/send") {
        const b = await body()
        const space = (b.space ?? "conversation") as Space
        if (S.busy) return json({ error: "une réponse est en cours" }, 409)
        if (space === "work" && needsProject(S.cwd)) return json({ error: "projet requis", propose: S.proposeProject(String(b.text ?? "")) }, 412)
        S.send(String(b.text ?? ""), space, { cg: !!b.cg, mediaModel: b.mediaModel }).catch(() => {})
        return json({ ok: true }, 202)
      }
      if (p === "/api/interrupt") return (S.interrupt(), stopSpeech?.(), json({ ok: true }))
      if (p === "/api/perm") {
        const b = await body()
        S.answerPerm(Number(b.id), b.decision)
        return json({ ok: true })
      }
      if (p === "/api/permmode") {
        const b = await body()
        if (String(b.mode).startsWith("bypass") && !S.perms.bypassVerified) {
          const r = await verifyPassword(async (cmd) => (await Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).exited))
          if (!r.ok) return json({ ok: false, message: `Bypass refusé : ${r.reason}` })
          S.perms.bypassVerified = true
        }
        S.setPerm(b.mode)
        return json({ ok: true, state: S.state() })
      }
      if (p === "/api/prefs") return (S.savePrefs(await body()), json(S.state()))
      if (p === "/api/project") {
        const b = await body()
        return json({ ok: true, path: S.enterProject(String(b.name ?? "projet")), state: S.state() })
      }
      if (p === "/api/sessions") return json(S.sessions())
      if (p === "/api/sessions/open") return json({ messages: S.openConversation(Number((await body()).id)), state: S.state() })
      if (p === "/api/new") return (S.newChat(), json(S.state()))
      if (p === "/api/agent-models") return json(await S.agentModelList(u.searchParams.get("agent") ?? ""))
      if (p === "/api/media/models") return json(S.mediaModels())
      if (p === "/api/mcp") return json(S.mcp.status)
      if (p === "/api/mcp/reload") return (await S.mcp.start(S.cwd, () => broadcast({ type: "state" })), json(S.mcp.status))
      // serveurs MCP du projet : la configuration est lue une fois, montrée en entier ; seule son empreinte est approuvée
      if (p === "/api/mcp/pending") return json(pendingProject(S.cwd).map((x) => ({ name: x.name, config: x.cfg, fingerprint: x.fp, files: x.files })))
      if (p === "/api/mcp/approve") {
        const b = await body()
        const x = pendingProject(S.cwd).find((y) => y.name === b.name)
        if (!x || x.fp !== b.fingerprint) return json({ ok: false, message: "La configuration a changé depuis l'affichage : relisez-la avant d'approuver." }, 409)
        approveFingerprint(S.cwd, x.name, x.fp)
        await S.mcp.start(S.cwd, () => broadcast({ type: "state" }))
        return json({ ok: true, status: S.mcp.status })
      }
      if (p === "/api/mcp/revoke") {
        const b = await body()
        await S.mcp.stopAll()
        const gone = revoke(S.cwd, String(b.name ?? ""), !!b.all)
        S.mcp.start(S.cwd, () => broadcast({ type: "state" }))
        return json({ ok: true, revoked: gone })
      }
      if (p === "/api/usage") {
        const per = [["aujourd'hui", dayStart()], ["cette semaine", weekStart()], ["ce mois", monthStart()], ["depuis le début", 0]] as const
        const bal = S.st.current?.provider === "poe" || S.keyState.poe === "ok" ? await poeBalance() : null
        return json({
          periods: per.map(([label, since]) => ({ label, ...usageBudget.totals(since), tokens: tokens(usageBudget.totals(since)) })),
          byModel: usageBudget.byModel(monthStart()).map((m) => ({ model: m.model, requests: m.requests, tokens: tokens(m), usd: m.usd })),
          daily: usageBudget.daily(30),
          envelopes: usageBudget.envelopes().map((e) => usageBudget.status(e)),
          poe: bal && bal.ok ? { points: bal.points, usd: bal.usd } : null,
        })
      }
      if (p === "/api/voice/status") return json(V.setup())
      if (p === "/api/voice/dictate") return json(await dictate())
      if (p === "/api/voice/call") {
        const b = await body()
        if (b.on === false) return (endCall(), json({ ok: true }))
        return json(startCall((b.space ?? "conversation") as Space, !!b.cg))
      }
      if (p === "/api/voice/stop-speech") return (stopSpeech?.(), json({ ok: true }))
      return json({ error: "inconnu" }, 404)
    } catch (e) {
      return json({ error: (e as Error).message }, 500)
    }
  },
})

console.log(JSON.stringify({ event: "ready", port: server.port, token }))

function shutdown() {
  endCall()
  S.close()
  server.stop(true)
  process.exit(0)
}
if (args.includes("--watch-stdin")) {
  ;(async () => {
    for await (const _ of process.stdin) {}
    shutdown()
  })()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
