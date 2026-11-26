/** Fournisseurs par clé d'API et serveurs locaux (compatibles OpenAI). Aucun n'est imposé ; Poe est recommandé. */
import { getKey, type KeyLookup } from "./secrets"

export interface ProviderSpec {
  id: string
  label: string
  baseUrl: string
  keyEnv: string | null
  local?: boolean
  recommended?: boolean
  publicCatalog?: boolean // catalogue lisible sans clé
}

export const PROVIDERS: ProviderSpec[] = [
  { id: "poe", label: "Poe", baseUrl: "https://api.poe.com/v1", keyEnv: "POE_API_KEY", recommended: true, publicCatalog: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", publicCatalog: true },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic (API)", baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "google", label: "Google Gemini (API)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
  { id: "github", label: "GitHub Models", baseUrl: "https://models.github.ai/inference", keyEnv: "GITHUB_MODELS_TOKEN" },
  { id: "opencode-zen", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", keyEnv: "OPENCODE_API_KEY" },
  { id: "opencode-go", label: "OpenCode Go (abonnement)", baseUrl: "https://opencode.ai/zen/go/v1", keyEnv: "OPENCODE_API_KEY" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", keyEnv: null, local: true },
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", keyEnv: null, local: true },
]

export function provider(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export async function keyFor(p: ProviderSpec): Promise<KeyLookup> {
  if (p.local) return { ok: true, key: "", source: "aucune clé (serveur local)" }
  return getKey(p.id, p.keyEnv)
}

export type KeyCheck = "valide" | "refusée" | "absente" | "non vérifiée"

/**
 * Vérifie réellement la clé auprès du fournisseur. Le catalogue de Poe est public (200 même avec une clé supprimée) :
 * la clé se vérifie sur /usage/current_balance (200 = acceptée, 401 = refusée). Ailleurs, GET /models avec la clé.
 */
export async function verifyKey(p: ProviderSpec, opts: { fetchImpl?: typeof fetch; key?: string } = {}): Promise<{ check: KeyCheck; detail: string }> {
  if (p.local) return { check: "valide", detail: "serveur local, sans clé" }
  let key = opts.key
  if (key === undefined) {
    const k = await keyFor(p)
    if (!k.ok) return { check: k.missing ? "absente" : "non vérifiée", detail: k.missing ? "aucune clé enregistrée" : k.reason }
    key = k.key
  }
  const url = p.id === "poe" ? "https://api.poe.com/usage/current_balance" : p.baseUrl + "/models"
  try {
    const r = await (opts.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
    if (r.status === 401 || r.status === 403) return { check: "refusée", detail: `${p.label} refuse la clé (HTTP ${r.status}) : supprimée ou modifiée` }
    if (r.ok) return { check: "valide", detail: "clé acceptée" }
    return { check: "non vérifiée", detail: `vérification impossible (HTTP ${r.status})` }
  } catch {
    return { check: "non vérifiée", detail: "vérification impossible (réseau)" }
  }
}

export interface ModelInfo {
  id: string
  provider: string
  label?: string
  context?: number
  free?: boolean
  tools?: boolean // le fournisseur annonce les appels d'outils
  input?: string[]
  output?: string[]
  effort?: string[] // valeurs d'effort proposées par le modèle
  effortParam?: string // nom du paramètre à envoyer (ex. reasoning_effort)
  priceIn?: number // $ par million de tokens
  priceOut?: number
}

/** Catalogue Poe. Corrige l'ancien filtre : `supported_endpoints` n'est pas documenté et vide pour la plupart des modèles. */
export function parsePoe(data: any[]): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const d of data) {
    const arch = d.architecture ?? {}
    const outMods: string[] = arch.output_modalities ?? ["text"]
    if (!outMods.includes("text")) continue // modèles qui ne produisent que des images, vidéos ou sons
    const price = d.pricing ?? {}
    const effP = (d.parameters ?? []).find((p: any) => /effort/i.test(p.name ?? ""))
    const eff = effP?.schema?.enum
    const pIn = price.prompt != null ? Number(price.prompt) * 1e6 : undefined
    const pOut = price.completion != null ? Number(price.completion) * 1e6 : undefined
    out.push({
      id: d.id, provider: "poe", context: d.context_window?.context_length ?? d.context_length ?? undefined,
      tools: (d.supported_features ?? []).includes("tools"), input: arch.input_modalities, output: outMods,
      effort: Array.isArray(eff) ? eff.map(String) : undefined, effortParam: Array.isArray(eff) ? effP.name : undefined, priceIn: pIn, priceOut: pOut,
      free: d.pricing === null ? undefined : pIn === 0 && pOut === 0,
    })
  }
  return out
}

export function parseGeneric(providerId: string, data: any[]): ModelInfo[] {
  return data.map((d) => {
    const pIn = d.pricing?.prompt != null ? Number(d.pricing.prompt) * 1e6 : undefined
    const pOut = d.pricing?.completion != null ? Number(d.pricing.completion) * 1e6 : undefined
    return { id: d.id, provider: providerId, context: d.context_length ?? d.context_window ?? undefined, priceIn: pIn, priceOut: pOut,
             free: pIn === 0 && pOut === 0 ? true : undefined,
             tools: Array.isArray(d.supported_parameters) ? d.supported_parameters.includes("tools") : undefined }
  })
}

export type CatalogResult = { ok: true; models: ModelInfo[] } | { ok: false; reason: string }

const cache = new Map<string, { at: number; res: CatalogResult }>()

export async function catalog(p: ProviderSpec, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; refresh?: boolean } = {}): Promise<CatalogResult> {
  const hit = cache.get(p.id)
  if (!opts.refresh && hit && Date.now() - hit.at < 600_000) return hit.res
  const f = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = {}
  if (!p.publicCatalog || p.id === "poe") {
    const k = await keyFor(p)
    if (k.ok && k.key) headers.Authorization = `Bearer ${k.key}`
    else if (!k.ok && !p.publicCatalog) return { ok: false, reason: k.missing ? "clé à saisir" : k.reason }
  }
  let res: CatalogResult
  try {
    const r = await f(p.baseUrl + "/models", { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? (p.local ? 1500 : 15_000)) })
    if (!r.ok) res = { ok: false, reason: r.status === 401 ? "clé refusée (HTTP 401)" : `HTTP ${r.status}` }
    else {
      const j: any = await r.json()
      const data = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []
      res = { ok: true, models: p.id === "poe" ? parsePoe(data) : parseGeneric(p.id, data) }
    }
  } catch (e) {
    const n = (e as Error).name
    res = { ok: false, reason: p.local ? "ne tourne pas" : n === "TimeoutError" ? "délai dépassé" : "réseau indisponible" }
  }
  cache.set(p.id, { at: Date.now(), res })
  return res
}

/** Solde réel du compte Poe (points et dollars), lu sur /usage/current_balance : valeur mesurée par Poe. */
export async function poeBalance(opts: { fetchImpl?: typeof fetch } = {}): Promise<{ ok: true; points: number; usd: number; nextGrant?: number } | { ok: false; reason: string }> {
  const p = provider("poe")!
  const k = await keyFor(p)
  if (!k.ok) return { ok: false, reason: k.missing ? "aucune clé Poe" : k.reason }
  try {
    const r = await (opts.fetchImpl ?? fetch)("https://api.poe.com/usage/current_balance", { headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(10_000) })
    if (r.status === 401) return { ok: false, reason: "clé Poe refusée (/connect)" }
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` }
    const j: any = await r.json()
    return { ok: true, points: Number(j.current_point_balance ?? 0), usd: Number(j.total_balance_usd ?? 0),
             nextGrant: j.next_daily_grant_time ? Number(j.next_daily_grant_time) / 1e6 : undefined }
  } catch {
    return { ok: false, reason: "réseau indisponible" }
  }
}
