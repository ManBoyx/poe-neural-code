/** Conversation en flux avec un fournisseur compatible OpenAI (POST /chat/completions, stream). Sans outils pour l'instant. */
import { keyFor, type ProviderSpec } from "./providers"

export interface Msg {
  role: "user" | "assistant" | "system"
  content: string
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "usage"; input?: number; output?: number }
  | { type: "error"; message: string }
  | { type: "done" }

const HINTS: Record<number, string> = {
  400: "requête refusée", 401: "clé invalide ou expirée", 402: "crédits insuffisants", 403: "accès refusé", 404: "modèle introuvable",
  408: "délai dépassé côté modèle", 413: "conversation trop longue pour ce modèle", 429: "limite de débit atteinte",
}

export async function* streamChat(p: ProviderSpec, model: string, messages: Msg[], opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; extra?: Record<string, unknown> } = {}): AsyncGenerator<ChatEvent> {
  const k = await keyFor(p)
  if (!k.ok) {
    yield { type: "error", message: `${p.label} : ${k.missing ? "aucune clé enregistrée — choisissez « Saisir la clé » dans /provider" : k.reason}` }
    return
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (k.key) headers.Authorization = `Bearer ${k.key}`
  const f = opts.fetchImpl ?? fetch
  let r: Response
  try {
    r = await f(p.baseUrl + "/chat/completions", {
      method: "POST", headers, signal: opts.signal,
      body: JSON.stringify({ ...(opts.extra ?? {}), model, messages, stream: true, stream_options: { include_usage: true } }),
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
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return
    yield { type: "error", message: `connexion interrompue (${(e as Error).name})` }
    return
  }
  yield { type: "done" }
}
