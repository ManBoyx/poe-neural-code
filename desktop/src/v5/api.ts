/**
 * Connexion au moteur Eclipse 5 (ts/src/server.ts) : HTTP local + flux d'événements (SSE).
 * Desktop : port et jeton donnés par Tauri (engine_info). Navigateur : jeton dans l'adresse (#token=…).
 * Le jeton ne s'affiche jamais et ne reste pas dans l'adresse.
 */
export const isDesktop = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
let base = "";
let token = "";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export async function connect(): Promise<void> {
  if (isDesktop) {
    const info = await invoke<{ port: number; token: string }>("engine_info");
    base = `http://127.0.0.1:${info.port}`;
    token = info.token;
    return;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  const fromHash = params.get("token");
  const port = params.get("port");
  if (fromHash) {
    try { sessionStorage.setItem("eclipse.token", fromHash); if (port) sessionStorage.setItem("eclipse.port", port); } catch { /* stockage indisponible */ }
    history.replaceState(null, "", location.pathname);
  }
  let stored: string | null = null, storedPort: string | null = null;
  try { stored = sessionStorage.getItem("eclipse.token"); storedPort = sessionStorage.getItem("eclipse.port"); } catch { /* idem */ }
  token = fromHash || stored || "";
  const p = port || storedPort;
  base = p ? `http://127.0.0.1:${p}` : location.origin;
  if (!token) throw new Error("Jeton absent : ouvrez Eclipse depuis l'application, ou relancez « eclipse-engine serve ».");
}

export async function restartEngine(): Promise<void> {
  const info = await invoke<{ port: number; token: string }>("engine_restart");
  base = `http://127.0.0.1:${info.port}`;
  token = info.token;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

export async function call<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error || `erreur ${r.status}`, j);
  return j as T;
}
export const get = <T = any>(path: string) => call<T>("GET", path);
export const post = <T = any>(path: string, body: unknown = {}) => call<T>("POST", path, body);

/** Flux d'événements du moteur ; se reconnecte seul. Renvoie une fonction d'arrêt. */
export function events(onEvent: (e: any) => void, onStatus: (connected: boolean) => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    es = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => onStatus(true);
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ligne illisible ignorée */ } };
    es.onerror = () => {
      onStatus(false);
      es?.close();
      if (!stopped) retry = setTimeout(open, 1500);
    };
  };
  open();
  return () => { stopped = true; clearTimeout(retry); es?.close(); };
}

// ------------------------------------------------------------------ types du moteur
export type Space = "conversation" | "work" | "medias";
export interface Choice { kind: "api" | "agent"; provider: string; model?: string }
export interface McpStatus { name: string; source: string; state: string; tools: number; error?: string; launch?: string }
export interface EngineState {
  cwd: string; cwdShort: string; protectedCwd: boolean; needsProject: boolean; projectsRoot: string;
  projects: { name: string; path: string; mtime: number }[];
  current: Choice | null; label: string; effort: string | null; efforts: string[];
  modelParams: { name: string; kind: string; choices?: string[]; description?: string }[];
  modelOptions: Record<string, unknown>; modelOutput: string[] | null; deepResearch: { provider: string; id: string }[];
  recents: (Choice & { at: number })[]; busy: boolean; title: string; conv: number | null; space: Space;
  perm: string; bypassVerified: boolean; sandbox: boolean; sandboxPref?: boolean;
  agents: { id: string; label: string; installed: boolean; version?: string; install?: string }[];
  detecting?: boolean;
  providers: { id: string; label: string; recommended: boolean; local: boolean; key: string; models: number }[];
  mcp: McpStatus[]; skills: number; todos: { text: string; status: string }[];
  cg: { lead: "claude" | "codex"; mode: "auto" | "seul" | "delegue"; review: boolean; subagents: boolean; agents: Record<string, { model?: string; effort?: string; power?: string }> };
  memory: number;
}
export interface SessionRow { id: number; title: string; project: number; last: number; count: number; space: Space; cg: boolean }
export interface ModelRow { id: string; free: boolean; priceIn?: number; priceOut?: number; context?: number; tools?: boolean; effort?: string[]; output?: string[]; category?: string }
export interface ModelsPayload {
  recents: (Choice & { at: number })[];
  providers: { id: string; label: string; recommended: boolean; local: boolean; key: string; models: ModelRow[] }[];
  agents: EngineState["agents"];
  categories?: { id: string; label: string }[];
}
export interface MediaModel { provider: string; id: string; output: string[]; price?: number; category?: string }
export interface Usage {
  periods: { label: string; requests: number; usd: number; tokens: number }[];
  byModel: { model: string; requests: number; tokens: number; usd: number }[];
  daily: { day: number; tokens: number; requests: number }[];
  envelopes: { envelope: { name: string; tokenLimit: number | null; amountPoints: number | null }; spentPoints: number; spentTokens: number; remainingPoints: number | null; remainingTokens: number | null }[];
  poe: { points: number; usd?: number } | null;
}
