/**
 * Moteur du desktop (Eclipse 5) : `eclipse-engine serve [--watch-stdin] [--port N]`.
 * Écoute sur 127.0.0.1 uniquement, avec un jeton aléatoire ; annonce {"event":"ready","port","token"} sur la sortie
 * (protocole attendu par l'application Tauri) ; s'arrête quand son entrée se ferme (--watch-stdin).
 * Même moteur et mêmes données que le terminal (mémoire, sessions, consommation, clés, MCP, projets).
 */
import { randomBytes } from "node:crypto"
import { Budget, dayStart, monthStart, tokens, weekStart } from "./core/budget"
import { CATEGORY_LABEL, CATEGORY_ORDER, keyFor, modelCategory, poeBalance, provider, PROVIDERS, verifyKey } from "./core/providers"
import { setKey } from "./core/secrets"
import { verifyPassword } from "./core/auth"
import { needsProject } from "./core/protect"
import * as V from "./core/voice"
import { cleanImages, EngineSession, type EngineEvent, type Space } from "./engine/session"
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

// ------------------------------------------------------------------ voix : dictée seulement
// L'utilisateur parle, le texte s'écrit dans la saisie. Transcription par OpenAI (pas de Whisper sur le PC, pas de voix
// de synthèse qui répète). Le micro est lu par arecord ; l'enregistrement s'arrête tout seul après un silence.
let dictating: { stop: () => void } | null = null
function voiceState(state: string, extra: Record<string, unknown> = {}) {
  broadcast({ type: "voice", state, ...extra })
}
async function voiceReady(): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  const s = V.setup()
  if (!s.record) return { ok: false, reason: "enregistreur absent : installez le paquet alsa-utils (arecord)" }
  const k = await keyFor(provider("openai")!)
  if (!k.ok) return { ok: false, reason: "la dictée utilise la transcription d'OpenAI : ajoutez une clé OpenAI dans Réglages > Clés d'API" }
  return { ok: true, key: k.key }
}
async function dictate(): Promise<{ ok: boolean; text?: string; reason?: string }> {
  if (dictating) return { ok: false, reason: "dictée déjà en cours" }
  const ready = await voiceReady()
  if (!ready.ok) return { ok: false, reason: ready.reason }
  const s = V.setup()
  return new Promise((res) => {
    voiceState("écoute")
    let done = false
    const finish = (r: { ok: boolean; text?: string; reason?: string }) => {
      if (done) return
      done = true
      dictating?.stop()
      dictating = null
      voiceState("")
      res(r)
    }
    const l = V.listen(s, {
      onUtterance: async (pcm) => {
        if (done) return
        l.stop()
        voiceState("transcription")
        const r = await V.transcribeCloud(pcm, ready.key)
        finish(r.ok ? { ok: true, text: r.text } : { ok: false, reason: r.reason })
      },
      onLevel: (level) => broadcast({ type: "voice-level", level }),
      onError: (m) => finish({ ok: false, reason: m }),
    })
    dictating = { stop: () => l.stop() }
    setTimeout(() => finish({ ok: false, reason: "rien entendu en 30 s" }), 30_000)
  })
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
            models: (S.models[pv.id] ?? []).map((m) => ({ id: m.id, free: !!m.free, priceIn: m.priceIn, priceOut: m.priceOut, context: m.context, tools: m.tools, effort: m.effort, output: m.output, category: modelCategory(m) })) })),
          categories: CATEGORY_ORDER.map((id) => ({ id, label: CATEGORY_LABEL[id] })),
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
        S.send(String(b.text ?? ""), space, { cg: !!b.cg, mediaModel: b.mediaModel, canvas: typeof b.canvas === "string" ? b.canvas : b.canvas === true ? "" : undefined, images: cleanImages(b.images) }).catch(() => {})
        return json({ ok: true }, 202)
      }
      if (p === "/api/interrupt") return (S.interrupt(), json({ ok: true }))
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
      if (p === "/api/model-options") return (S.setModelOptions((await body()).values ?? {}), json(S.state()))
      // pendant une réponse, on ne change ni de discussion ni de projet (la réponse en cours s'enregistrerait ailleurs)
      if ((p === "/api/sessions/open" || p === "/api/new" || p === "/api/project") && S.busy) return json({ error: "une réponse est en cours : attendez la fin ou arrêtez-la" }, 409)
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
      if (p === "/api/voice/status") {
        const r = await voiceReady()
        return json(r.ok ? { ok: true } : { ok: false, reason: r.reason }) // jamais la clé
      }
      if (p === "/api/voice/dictate") return json(await dictate())
      if (p === "/api/voice/stop") return (dictating?.stop(), json({ ok: true }))
      return json({ error: "inconnu" }, 404)
    } catch (e) {
      return json({ error: (e as Error).message }, 500)
    }
  },
})

console.log(JSON.stringify({ event: "ready", port: server.port, token }))

function shutdown() {
  dictating?.stop()
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
