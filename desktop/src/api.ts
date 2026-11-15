// Client du moteur Eclipse (serveur local : src/poe_neural_code/web/server.py).
// Application desktop : port et jeton fournis par Tauri. Navigateur (`eclipse web`) : jeton dans l'adresse (#token=…).

export interface SessionSummary { id: string; title: string; workspace: string; updated: number; mode: string }
export interface Info { version: string; sessions: SessionSummary[]; recent_dirs: string[]; home: string; theme: string; current: string | null; discussions_dir: string }
export interface ModelEntry { id: string; free: boolean; context: number | null; tools: boolean; description: string }
export interface Effort { name: string; choices: string[]; default: unknown; current: unknown }
export interface Todo { id: number; content: string; status: string }
export interface PermissionRequest {
  tool: string; kind: string; summary: string; detail: string; destructive: boolean; outside: boolean; warnings: string[];
}
export interface PermissionEvent { type: "permission"; id: string; request: PermissionRequest }
export interface State {
  open: boolean; version: string; busy?: boolean;
  session?: { id: string; title: string; workspace: string; agent: string };
  mode?: string; mode_label?: string; is_cli?: boolean; configured?: boolean;
  model?: string | null; models?: ModelEntry[]; effort?: Effort | null; agents?: string[];
  permissions?: string; todos?: Todo[]; pending_permissions?: PermissionEvent[];
  auto_edits?: boolean; context?: { used: number; window: number | null }; ref_limit?: number;
}
export interface MemoryItem { id: number; kind: string; key: string | null; content: string; created: number; sources: Record<string, unknown>[] }
export interface MemoryView {
  items: MemoryItem[]; hits: { ref: string; layer: string; text: string }[];
  stats: { items: number; summaries: number; archives: number; conversations: number; cache_hits: number; cache_misses: number };
}
export interface FileEntry { path: string; size: number; mtime: number; recent: boolean }
export interface FilePreview { path: string; size: number; text?: string; image?: string; binary?: boolean; truncated?: boolean }
export interface Changes { available: boolean; reason?: string; shadow?: boolean; files: { status: string; path: string }[]; diff: string; truncated: boolean }
export interface SearchResult { id: string; title: string; workspace: string; snippet: string; ts: number | null }
export interface PromptCommand { name: string; description: string; kind: string; usage: string }
export type Upload = { kind: "image"; path: string; name: string; size: number } | { kind: "text"; name: string; text: string; size: number };
export type TranscriptItem =
  | { kind: "user" | "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; output: string | null; ok: boolean | null };
export interface Envelope {
  name: string; kind: string; period_s: number; renews_at: number | null; spent_points: number; total_points: number | null;
  spent_tokens: number; token_limit: number | null; on_exhaust: string;
}
export interface Usage {
  subscription: boolean; mode_label: string; session_tokens: { in: number; out: number }; now: number;
  totals: { requests: number; usd: number; points: Record<string, number>; tokens_in: Record<string, number>; tokens_out: Record<string, number>; points_unavailable_requests: number };
  envelopes: Envelope[];
  claude?: { model: string | null; cache_read_tokens: number; cost_usd_equiv: number;
    windows: { key: string; name: string; seconds: number | null; utilization: number | null; resets_at: number | null }[] };
}
export interface Connections {
  agents: { id: string; label: string; installed: boolean; path: string | null; note: string }[];
  apis: { id: string; label: string; key_required: boolean; has_key: boolean; note: string }[];
  storage: string; current: string | null;
}

export const isDesktop = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
let base = "";
let token = "";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** Connexion au moteur. Desktop : attend qu'il soit prêt (Tauri, 60 s au plus). Navigateur : jeton de l'adresse. */
export async function connect(): Promise<void> {
  if (isDesktop) {
    const info = await invoke<{ port: number; token: string }>("engine_info");
    base = `http://127.0.0.1:${info.port}`;
    token = info.token;
  } else {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
    if (fromHash) {
      try { sessionStorage.setItem("eclipse.token", fromHash); } catch { /* stockage indisponible */ }
      history.replaceState(null, "", location.pathname); // le jeton ne reste pas dans l'adresse
    }
    let stored: string | null = null;
    try { stored = sessionStorage.getItem("eclipse.token"); } catch { /* idem */ }
    token = fromHash || stored || "";
    base = location.origin;
    if (!token) throw new Error("Jeton absent : relancez « eclipse web » pour obtenir une adresse valide.");
  }
}

/** Relance du moteur (desktop) : nouveau processus, nouveau port, nouveau jeton. */
export async function restartEngine(): Promise<void> {
  const info = await invoke<{ port: number; token: string }>("engine_restart");
  base = `http://127.0.0.1:${info.port}`;
  token = info.token;
}

/** Le moteur répond-il ? (délai court, jamais d'exception) */
export async function health(timeoutMs = 3000): Promise<boolean> {
  if (!base) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}

/** Erreurs de l'interface -> logs/ui.log du moteur (sans bloquer, sans jamais lever). */
export function logError(message: string, level: "error" | "warning" | "info" = "error"): void {
  if (!base) return;
  fetch(`${base}/api/log`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ level, message: message.slice(0, 4000) }) }).catch(() => undefined);
}

/** Ouvre le dossier des logs (desktop) ; dans le navigateur, renvoie seulement son chemin. */
export async function openLogs(): Promise<string> {
  if (isDesktop) return invoke<string>("open_logs");
  return (await call<{ dir: string }>("GET", "/api/logs")).dir;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any).error || `erreur ${r.status}`);
  return data as T;
}

export const api = {
  info: () => call<Info>("GET", "/api/info"),
  state: () => call<State>("GET", "/api/state"),
  transcript: () => call<{ items: TranscriptItem[] }>("GET", "/api/transcript"),
  usage: () => call<Usage>("GET", "/api/usage"),
  connections: () => call<Connections>("GET", "/api/connections"),
  open: (b: { workspace?: string; resume?: string }) => call<State>("POST", "/api/open", b),
  newDiscussion: () => call<State>("POST", "/api/new_discussion", {}),
  settings: (b: { discussions_dir?: string }) => call<{ discussions_dir: string }>("POST", "/api/settings", b),
  remove: (id: string) => call<{ deleted: boolean }>("DELETE", `/api/sessions/${encodeURIComponent(id)}`),
  prompt: (text: string, attachments: string[] = []) => call<{ ok: boolean }>("POST", "/api/prompt", { text, attachments }),
  memory: (q = "") => call<MemoryView>("GET", `/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  forget: (id: number) => call<{ ok: boolean }>("DELETE", `/api/memory/${id}`),
  files: () => call<{ root: string; files: FileEntry[] }>("GET", "/api/files"),
  file: (path: string) => call<FilePreview>("GET", `/api/file?path=${encodeURIComponent(path)}`),
  upload: (name: string, data: string) => call<Upload>("POST", "/api/upload", { name, data }),
  autoEdits: (on: boolean) => call<State>("POST", "/api/auto_edits", { on }),
  changes: () => call<Changes>("GET", "/api/changes"),
  revertAll: () => call<{ ok: boolean; touched: string[] }>("POST", "/api/changes/revert", {}),
  exportMd: () => call<{ markdown: string; filename: string }>("GET", "/api/export"),
  exportTo: (path: string) => call<{ ok: boolean; path: string }>("POST", "/api/export", { path }),
  search: (q: string) => call<{ results: SearchResult[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  commands: () => call<{ commands: PromptCommand[] }>("GET", "/api/commands"),
  command: (name: string, args: string) => call<{ ok: boolean; shown: string }>("POST", "/api/command", { name, args }),
  editLast: () => call<{ ok: boolean; text: string; items: TranscriptItem[] }>("POST", "/api/edit", {}),
  compact: () => call<{ ok: boolean; message: string }>("POST", "/api/compact", {}),
  fork: () => call<State>("POST", "/api/fork", {}),
  retry: () => call<{ ok: boolean; text: string; items: TranscriptItem[] }>("POST", "/api/retry", {}),
  interrupt: () => call<{ ok: boolean }>("POST", "/api/interrupt", {}),
  permission: (id: string, decision: "once" | "session" | "deny") => call("POST", "/api/permission", { id, decision }),
  model: (model: string) => call<State>("POST", "/api/model", { model }),
  effort: (value: string | null) => call<State>("POST", "/api/effort", { value }),
  agent: (name: string) => call<State>("POST", "/api/agent", { name }),
  connect: (target: string, key?: string) =>
    call<{ ok: boolean; message?: string; need_key?: boolean; storage?: string; state?: State }>("POST", "/api/connect", { target, key }),
  rename: (title: string) => call<State>("POST", "/api/rename", { title }),
  undo: () => call<{ ok: boolean; items: TranscriptItem[] }>("POST", "/api/undo", {}),
  redo: () => call<{ ok: boolean; items: TranscriptItem[] }>("POST", "/api/redo", {}),
};

/** Flux d'événements du moteur ; reconnexion automatique (EventSource). */
export function events(onEvent: (e: any) => void, onStatus: (connected: boolean) => void): () => void {
  const es = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener("hello", () => onStatus(true));
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* message illisible ignoré */ } };
  es.onerror = () => onStatus(false);
  return () => es.close();
}
