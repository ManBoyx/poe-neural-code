/** Conversation en flux avec un fournisseur compatible OpenAI (POST /chat/completions, stream). Sans outils pour l'instant. */
import { keyFor, type ProviderSpec } from "./providers"

export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }

export interface Msg {
  role: "user" | "assistant" | "system" | "tool"
  content: string | Part[] | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "usage"; input?: number; output?: number }
  | { type: "error"; message: string }
  | { type: "tools"; calls: { id: string; name: string; args: string }[] }
  | { type: "done" }

const HINTS: Record<number, string> = {
  400: "requête refusée", 401: "clé invalide ou expirée", 402: "crédits insuffisants", 403: "accès refusé", 404: "modèle introuvable",
  408: "délai dépassé côté modèle", 413: "conversation trop longue pour ce modèle", 429: "limite de débit atteinte",
}

/** Contenu d'une réponse complète (texte, ou liste de parties : texte, image, audio, vidéo) en Markdown affichable. */
export function contentToMarkdown(c: unknown): string {
  if (typeof c === "string") return c
  if (!Array.isArray(c)) return c == null ? "" : JSON.stringify(c)
  return c.map((part: any) => {
    if (!part || typeof part !== "object") return String(part ?? "")
    if (part.type === "text") return String(part.text ?? "")
    const url = part.image_url?.url ?? part.video_url?.url ?? part.audio_url?.url ?? part.file?.url ?? part.url
    if (typeof url === "string") return part.type === "image_url" ? `![image](${url})` : `[${part.type?.replace("_url", "") ?? "média"}](${url})`
    if (part.type === "input_audio" || part.audio) return "(son reçu, format non affichable)"
    return ""
  }).filter(Boolean).join("\n\n")
}

export async function* streamChat(p: ProviderSpec, model: string, messages: Msg[], opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; extra?: Record<string, unknown>; tools?: unknown[]; noStream?: boolean } = {}): AsyncGenerator<ChatEvent> {
  const k = await keyFor(p)
  if (!k.ok) {
    yield { type: "error", message: `${p.label} : ${k.missing ? "aucune clé enregistrée — choisissez « Saisir la clé » dans /provider" : k.reason}` }
    return
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (k.key) headers.Authorization = `Bearer ${k.key}`
  const f = opts.fetchImpl ?? fetch
  // modèles d'images, de vidéos ou de sons : réponse complète en une fois (recommandé par Poe), pas de flux
  if (opts.noStream) {
    let r: Response
    try {
      r = await f(p.baseUrl + "/chat/completions", { method: "POST", headers, signal: opts.signal, body: JSON.stringify({ ...(opts.extra ?? {}), model, messages, stream: false }) })
    } catch (e) {
      if ((e as Error).name === "AbortError") return
      yield { type: "error", message: `${p.label} injoignable (${(e as Error).name})` }
      return
    }
    let j: any = null
    try { j = await r.json() } catch {}
    if (!r.ok) {
      yield { type: "error", message: `HTTP ${r.status} — ${HINTS[r.status] ?? "erreur du fournisseur"}${j?.error?.message ? " : " + String(j.error.message).slice(0, 300) : ""}` }
      return
    }
    const text = contentToMarkdown(j?.choices?.[0]?.message?.content)
    if (text) yield { type: "text", text }
    if (j?.usage) yield { type: "usage", input: j.usage.prompt_tokens, output: j.usage.completion_tokens }
    yield { type: "done" }
    return
  }
  let r: Response
  try {
    r = await f(p.baseUrl + "/chat/completions", {
      method: "POST", headers, signal: opts.signal,
      body: JSON.stringify({ ...(opts.extra ?? {}), model, messages, stream: true, stream_options: { include_usage: true }, ...(opts.tools?.length ? { tools: opts.tools } : {}) }),
    })
  } catch (e) {
    if ((e as Error).name === "AbortError") return
    yield { type: "error", message: `${p.label} injoignable (${(e as Error).name})` }
    return
  }
  if (!r.ok || !r.body) {
    let detail = ""
    try {
      const j: any = await r.json()
      detail = j?.error?.message ?? ""
    } catch {}
    yield { type: "error", message: `HTTP ${r.status} — ${HINTS[r.status] ?? "erreur du fournisseur"}${detail ? " : " + detail.slice(0, 300) : ""}` }
    return
  }
  const calls = new Map<number, { id: string; name: string; args: string }>()
  const flush = function* (): Generator<ChatEvent> {
    if (calls.size) yield { type: "tools", calls: [...calls.entries()].sort((x, y) => x[0] - y[0]).map(([i, c]) => ({ ...c, id: c.id || `call_${i}` })) }
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith("data:")) continue
        const payload = line.slice(5).trim()
        if (payload === "[DONE]") {
          yield* flush()
          yield { type: "done" }
          return
        }
        let d: any
        try {
          d = JSON.parse(payload)
        } catch {
          continue
        }
        if (d.usage) yield { type: "usage", input: d.usage.prompt_tokens, output: d.usage.completion_tokens }
        for (const ch of d.choices ?? []) {
          const delta = ch.delta ?? {}
          const th = delta.reasoning_content ?? delta.reasoning
          if (typeof th === "string" && th) yield { type: "thinking", text: th }
          if (delta.content) yield { type: "text", text: delta.content }
          for (const tc of delta.tool_calls ?? []) {
            const slot = calls.get(tc.index ?? 0) ?? { id: "", name: "", args: "" }
            slot.id = tc.id || slot.id
            slot.name += tc.function?.name ?? ""
            slot.args += tc.function?.arguments ?? ""
            calls.set(tc.index ?? 0, slot)
          }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return
    yield { type: "error", message: `connexion interrompue (${(e as Error).name})` }
    return
  }
  yield* flush()
  yield { type: "done" }
}
