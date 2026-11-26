/**
 * État du fil (messages, outils, zones /cg, sous-agents), construit à partir des événements du moteur.
 * Fonctions pures : (état, événement) -> nouvel état. Rien n'est jamais injecté en HTML ici.
 */
import type { Space } from "./api";

export type Block =
  | { k: "text"; text: string }
  | { k: "thinking"; text: string }
  | { k: "tool"; id: string; name: string; summary: string; done: boolean; ok?: boolean; output?: string; diff?: string }
  | { k: "notice"; text: string; level: "info" | "warn" | "error" };

export interface Msg {
  id: number;
  role: "user" | "assistant";
  text: string; // message de l'utilisateur, ou réponse finale (assistant)
  blocks: Block[];
  space: Space;
  cg?: boolean;
  done?: boolean;
  seconds?: number;
  interrupted?: boolean;
  tokens?: number;
}

export const SUB_COLORS = ["#e87ba4", "#3987e5", "#c98500", "#199e70", "#d95926", "#9085e9", "#22b8cf", "#e66767"];
export interface Sub { id: string; agent: string; label: string; color: string; done: boolean; ok?: boolean; report?: string; entries: Block[] }
export interface Zone { status: string; entries: Block[] }
export type CgAgentId = "claude" | "codex";
export const CG_LABEL: Record<CgAgentId, string> = { claude: "Claude Code", codex: "Codex" };
const BY_LABEL: Record<string, CgAgentId> = { "Claude Code": "claude", Codex: "codex" };

export interface ThreadState {
  msgs: Msg[];
  zones: Record<CgAgentId, Zone>;
  subs: Sub[];
  phase: string;
  cgTurn: boolean; // le tour en cours est un tour /cg
  seq: number;
}

export const emptyThread = (): ThreadState => ({
  msgs: [], zones: { claude: { status: "en attente", entries: [] }, codex: { status: "en attente", entries: [] } }, subs: [], phase: "", cgTurn: false, seq: 0,
});

/** Ajoute un bloc à une liste en fusionnant les morceaux de texte (ou de réflexion) qui se suivent. */
function push(list: Block[], b: Block): Block[] {
  const last = list[list.length - 1];
  if ((b.k === "text" || b.k === "thinking") && last && last.k === b.k) return [...list.slice(0, -1), { ...last, text: last.text + b.text }];
  if (b.k === "tool") {
    const i = list.findIndex((x) => x.k === "tool" && x.id === b.id);
    if (i >= 0) return list.map((x, j) => (j === i ? { ...(x as any), ...b, summary: b.summary || (x as any).summary } : x));
  }
  return [...list, b].slice(-400);
}

function lastAssistant(s: ThreadState, f: (m: Msg) => Msg): ThreadState {
  const i = s.msgs.map((m) => m.role).lastIndexOf("assistant");
  if (i < 0) return s;
  return { ...s, msgs: s.msgs.map((m, j) => (j === i ? f(m) : m)) };
}

function toSub(s: ThreadState, parent: string, b: Block): ThreadState | null {
  const i = s.subs.findIndex((x) => x.id === parent);
  if (i < 0) return null;
  return { ...s, subs: s.subs.map((x, j) => (j === i ? { ...x, entries: push(x.entries, b) } : x)) };
}

function toZone(s: ThreadState, who: string | undefined, b: Block): ThreadState | null {
  const a = who ? BY_LABEL[who] : undefined;
  if (!s.cgTurn || !a) return null;
  return { ...s, zones: { ...s.zones, [a]: { ...s.zones[a], entries: push(s.zones[a].entries, b) } } };
}

/** Applique un événement du moteur. `cg` : le message envoyé était un tour /cg (connu de l'interface). */
export function reduce(s: ThreadState, e: any, opts: { cg: boolean } = { cg: false }): ThreadState {
  switch (e.type) {
    case "turn": {
      const seq = s.seq + 2;
      const user: Msg = { id: seq - 1, role: "user", text: e.text, blocks: [], space: e.space };
      const bot: Msg = { id: seq, role: "assistant", text: "", blocks: [], space: e.space, cg: opts.cg };
      const fresh = opts.cg ? { zones: emptyThread().zones, phase: "Le coordinateur lit la demande…" } : {};
      return { ...s, ...fresh, subs: [], cgTurn: opts.cg, seq, msgs: [...s.msgs, user, bot] };
    }
    case "text":
    case "thinking": {
      const b: Block = { k: e.type, text: String(e.text ?? "") };
      return (e.parent && toSub(s, e.parent, b)) || toZone(s, e.who, b) || lastAssistant(s, (m) => ({ ...m, blocks: push(m.blocks, b) }));
    }
    case "tool": {
      const b: Block = { k: "tool", id: e.id, name: e.name, summary: e.summary ?? "", done: !!e.done, ok: e.ok, output: e.output, diff: e.diff };
      return (e.parent && toSub(s, e.parent, b)) || toZone(s, e.who, b) || lastAssistant(s, (m) => ({ ...m, blocks: push(m.blocks, b) }));
    }
    case "subagent": {
      const i = s.subs.findIndex((x) => x.id === e.id);
      if (i >= 0) return { ...s, subs: s.subs.map((x, j) => (j === i ? { ...x, label: e.label || x.label, done: !!e.done, ok: e.ok, report: e.output ?? x.report } : x)) };
      const sub: Sub = { id: e.id, agent: e.agent, label: e.label || "sous-agent", color: SUB_COLORS[s.subs.length % SUB_COLORS.length], done: !!e.done, ok: e.ok, report: e.output, entries: [] };
      return { ...s, subs: [...s.subs, sub] };
    }
    case "cg": {
      let n = s;
      if (e.phase) n = { ...n, phase: e.phase };
      if (e.status?.agent && (e.status.agent === "claude" || e.status.agent === "codex"))
        n = { ...n, zones: { ...n.zones, [e.status.agent]: { ...n.zones[e.status.agent as CgAgentId], status: e.status.status } } };
      return n;
    }
    case "notice": {
      const b: Block = { k: "notice", text: e.text, level: e.level ?? "info" };
      const last = s.msgs[s.msgs.length - 1];
      return last && last.role === "assistant" && !last.done ? lastAssistant(s, (m) => ({ ...m, blocks: push(m.blocks, b) })) : s;
    }
    case "usage":
      return lastAssistant(s, (m) => ({ ...m, tokens: (m.tokens ?? 0) + (e.input ?? 0) + (e.output ?? 0) }));
    case "done":
      return lastAssistant({ ...s, phase: s.cgTurn ? s.phase : "" }, (m) => {
        const hasText = m.blocks.some((b) => b.k === "text" && b.text.trim());
        // /cg : la réponse finale (synthèse) remplace le fil des agents, qui reste lisible dans leurs onglets
        const text = m.cg || !hasText ? String(e.text ?? "") : "";
        return { ...m, done: true, seconds: e.seconds, interrupted: !!e.interrupted, text };
      });
    default:
      return s;
  }
}

/** Fil reconstruit depuis une discussion enregistrée (messages simples). */
export function fromHistory(rows: { role: string; text: string }[], space: Space): ThreadState {
  const s = emptyThread();
  rows.forEach((r, i) => s.msgs.push({ id: i + 1, role: r.role === "user" ? "user" : "assistant", text: r.text, blocks: [], space, done: true }));
  s.seq = rows.length + 1;
  return s;
}

/** Texte complet d'un message (pour la recherche de graphiques et de médias). */
export const msgText = (m: Msg) => m.text + m.blocks.map((b) => (b.k === "text" ? b.text : "")).join("");
