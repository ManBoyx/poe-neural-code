// Fil de la conversation : messages, réflexion, outils (avec diff), notes et demandes d'autorisation.
import { useEffect, useRef, useState } from "preact/hooks";
import { isDesktop, type PermissionEvent } from "./api";
import { I, TOOL_ICON } from "./icons";
import { renderMarkdown } from "./markdown";

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; live?: boolean }
  | { kind: "thinking"; text: string; live?: boolean }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; output: string | null; ok: boolean | null; diff?: string }
  | { kind: "note"; text: string; level: "info" | "warn" | "error" | "ok" };

const TOOL_LABEL: Record<string, string> = {
  read_file: "Lecture", list_dir: "Dossier", search_files: "Recherche", write_file: "Écriture", edit_file: "Modification",
  delete_file: "Suppression", run_command: "Commande", todo_write: "Tâches", web_fetch: "Page web", ask_helper: "Consultation",
  memory_search: "Mémoire", memory_load: "Mémoire", memory_note: "Mémoire", skill: "Skill",
};

function toolSummary(name: string, args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const v = pick("command") || pick("path") || pick("pattern") || pick("url") || pick("query") || pick("prompt") ||
    Object.values(args).find((x) => typeof x === "string") as string || "";
  return v.split("\n")[0].slice(0, 140);
}

function Markdown({ text }: { text: string }) {
  return <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre class="diff">
      {diff.split("\n").map((l, i) => (
        <span key={i} class={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
          {l + "\n"}
        </span>
      ))}
    </pre>
  );
}

function ToolCard({ it }: { it: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const running = it.ok === null && it.output === null;
  const state = running ? "running" : it.ok ? "ok" : "fail";
  const hasBody = Boolean(it.output || it.diff);
  return (
    <div class={`tool ${state}`}>
      <button class="tool-head" onClick={() => hasBody && setOpen(!open)} aria-expanded={open}>
        <span class="ico tool-ico">{TOOL_ICON[it.name] ?? (it.name.startsWith("mcp__") ? I.plug : I.tools)}</span>
        <span class="tool-name">{TOOL_LABEL[it.name] ?? it.name}</span>
        <span class="tool-sum">{toolSummary(it.name, it.args)}</span>
        <span class="tool-state">{running ? <span class="spinner" /> : <span class="ico">{it.ok ? I.check : I.error}</span>}</span>
        {hasBody && <span class={`ico chev ${open ? "open" : ""}`}>{I.chevronR}</span>}
      </button>
      {it.diff && <DiffView diff={it.diff} />}
      {open && it.output && <pre class="tool-out">{it.output}</pre>}
    </div>
  );
}

function Thinking({ it }: { it: Extract<Item, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="thinking">
      <button onClick={() => setOpen(!open)}><span class="ico">{I.thinking}</span> {it.live ? "Réflexion en cours…" : "Réflexion"} <span class={`ico chev ${open ? "open" : ""}`}>{I.chevronR}</span></button>
      {open && <div class="thinking-body">{it.text}</div>}
    </div>
  );
}

export function PermissionCard({ p, onDecide }: { p: PermissionEvent; onDecide: (d: "once" | "session" | "deny") => void }) {
  const r = p.request;
  const danger = r.destructive || r.outside;
  return (
    <div class={`perm ${danger ? "danger" : ""}`} role="alertdialog" aria-label="Autorisation demandée">
      <div class="perm-head">
        <span class="ico">{danger ? I.warn : I.shield}</span>
        <strong>{r.summary}</strong>
        {r.destructive && <span class="tag red">destructif</span>}
        {r.outside && <span class="tag amber">hors du projet</span>}
      </div>
      {r.detail && (r.kind === "write" || r.detail.startsWith("---") ? <DiffView diff={r.detail} /> : <pre class="perm-detail">{r.detail}</pre>)}
      {r.warnings?.length > 0 && <ul class="perm-warn">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <div class="perm-actions">
        <button class="btn" onClick={() => onDecide("deny")}>Refuser</button>
        {!danger && <button class="btn" onClick={() => onDecide("session")}>Autoriser pour la session</button>}
        <button class="btn primary" onClick={() => onDecide("once")}>Autoriser une fois</button>
      </div>
    </div>
  );
}

export function Thread({ items, pending, busy, onDecide, empty, onRetry }: {
  items: Item[]; pending: PermissionEvent[]; busy: boolean; onDecide: (id: string, d: "once" | "session" | "deny") => void; empty: preact.ComponentChildren;
  onRetry?: () => void;
}) {
  const lastAssistant = items.reduce((acc, it, i) => (it.kind === "assistant" ? i : acc), -1);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const onClick = async (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const a = t.closest("a[href]") as HTMLAnchorElement | null;
    if (a && /^https?:/i.test(a.href)) {
      e.preventDefault(); // lien externe : navigateur de l'utilisateur, jamais dans la fenêtre d'Eclipse
      if (isDesktop) (await import("@tauri-apps/plugin-opener")).openUrl(a.href);
      else window.open(a.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (t.matches("[data-copy]")) {
      const code = t.closest(".code")?.querySelector("pre")?.textContent ?? "";
      await navigator.clipboard.writeText(code).catch(() => undefined);
      t.textContent = "Copié";
      setTimeout(() => (t.textContent = "Copier"), 1500);
    }
  };
  return (
    <div class="thread" ref={ref} onScroll={onScroll} onClick={onClick}>
      <div class="thread-inner">
        {items.length === 0 && !busy ? empty : null}
        {items.map((it, i) => {
          switch (it.kind) {
            case "user": return <div key={i} class="msg user"><div class="bubble">{it.text}</div></div>;
            case "assistant": return (
              <div key={i} class={`msg assistant ${it.live ? "live" : ""}`}>
                <Markdown text={it.text} />
                {!it.live && (
                  <div class="msg-actions">
                    <button class="mini" title="Copier la réponse" onClick={() => navigator.clipboard.writeText(it.text)}><span class="ico">{I.copy}</span> Copier</button>
                    {i === lastAssistant && !busy && onRetry && <button class="mini" title="Annuler ce tour et renvoyer le même message" onClick={onRetry}><span class="ico">{I.retry}</span> Relancer</button>}
                  </div>
                )}
              </div>);
            case "thinking": return <Thinking key={i} it={it} />;
            case "tool": return <ToolCard key={it.id || i} it={it} />;
            case "note": return <div key={i} class={`note ${it.level}`}><span class="ico">{it.level === "error" ? I.error : it.level === "warn" ? I.warn : I.info}</span>{it.text}</div>;
          }
        })}
        {pending.map((p) => <PermissionCard key={p.id} p={p} onDecide={(d) => onDecide(p.id, d)} />)}
        {busy && pending.length === 0 && <div class="working"><span class="dots"><i /><i /><i /></span> Eclipse travaille…</div>}
      </div>
    </div>
  );
}
