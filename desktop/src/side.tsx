// Panneau latéral (Mémoire, Fichiers), aperçu de fichier, palette de commandes et fenêtres de dialogue.
import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type Changes, type FileEntry, type FilePreview, type MemoryView } from "./api";
import { I } from "./icons";
import { Modal } from "./panels";
import { DiffView } from "./thread";

const KIND_LABEL: Record<string, string> = {
  goal: "Objectifs", constraint: "Contraintes", decision: "Décisions", fact: "Faits", hypothesis: "Hypothèses",
  task: "Tâches", error: "Erreurs corrigées", question: "Questions ouvertes",
};
const KIND_ORDER = ["goal", "constraint", "decision", "fact", "task", "error", "hypothesis", "question"];
const size = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(1)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);

// --- Dialogues (remplacent prompt()/confirm(), indisponibles ou peu fiables dans la fenêtre de l'application) --------
export interface DialogSpec { title: string; message?: string; input?: string; confirm: string; danger?: boolean; resolve: (v: string | boolean | null) => void }

export function Dialog({ spec, onDone }: { spec: DialogSpec; onDone: () => void }) {
  const [value, setValue] = useState(spec.input ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const close = (v: string | boolean | null) => { spec.resolve(v); onDone(); };
  return (
    <Modal title={spec.title} icon={spec.danger ? I.warn : I.edit} onClose={() => close(null)}>
      <form onSubmit={(e) => { e.preventDefault(); close(spec.input !== undefined ? value : true); }}>
        {spec.message && <p>{spec.message}</p>}
        {spec.input !== undefined && <input ref={ref} class="text wide" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} autoFocus />}
        <div class="row-end">
          <button type="button" class="btn" onClick={() => close(null)}>Annuler</button>
          <button class={`btn primary ${spec.danger ? "danger" : ""}`} autoFocus={spec.input === undefined}>{spec.confirm}</button>
        </div>
      </form>
    </Modal>
  );
}

// --- Mémoire ------------------------------------------------------------------------------------------------------------
export function MemoryPanel({ ask, refreshKey }: { ask: (s: Omit<DialogSpec, "resolve">) => Promise<string | boolean | null>; refreshKey: number }) {
  const [m, setM] = useState<MemoryView | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const load = (query = q) => api.memory(query).then((v) => { setM(v); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [refreshKey]);
  useEffect(() => { const t = setTimeout(() => load(q), 250); return () => clearTimeout(t); }, [q]);
  const groups = useMemo(() => {
    const g = new Map<string, MemoryView["items"]>();
    for (const it of m?.items ?? []) g.set(it.kind, [...(g.get(it.kind) ?? []), it]);
    return [...g.entries()].sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]));
  }, [m]);
  const forget = async (id: number, content: string) => {
    if (await ask({ title: "Oublier cette note ?", message: `« ${content.slice(0, 160)} » ne sera plus fournie à l'IA. L'historique est conservé.`, confirm: "Oublier", danger: true })) {
      await api.forget(id).catch((e) => setError(e.message));
      load();
    }
  };
  return (
    <div class="memory">
      <p class="explain-small">
        Ce que l'IA a retenu pour ce dossier. Ces notes lui sont renvoyées à chaque tour pour quelques tokens, au lieu de relire les échanges entiers.
      </p>
      {m && (
        <div class="stats">
          <span><b>{m.stats.items}</b> notes</span><span><b>{m.stats.summaries}</b> résumés</span>
          <span><b>{m.stats.archives}</b> messages archivés</span><span><b>{m.stats.conversations}</b> conversations</span>
        </div>
      )}
      <div class="side-search inline"><span class="ico">{I.search}</span><input placeholder="Rechercher dans la mémoire" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></div>
      {error && <p class="err small">{error}</p>}
      {q && m && (
        <section>
          <h3>Résultats ({m.hits.length})</h3>
          {m.hits.length === 0 && <p class="muted small">Rien trouvé.</p>}
          {m.hits.map((h) => <div class="hit" key={h.ref}><span class="tag">{h.ref}</span> {h.text}</div>)}
        </section>
      )}
      {!q && groups.length === 0 && m && <p class="muted small pad0">Aucune note pour l'instant : l'IA en crée au fil du travail (décisions, faits, erreurs corrigées…).</p>}
      {!q && groups.map(([kind, list]) => (
        <section key={kind}>
          <h3>{KIND_LABEL[kind] ?? kind}</h3>
          {list.map((it) => (
            <div class="note-item" key={it.id}>
              <div class="ni-text">{it.content}</div>
              <div class="ni-meta">
                <span>{new Date(it.created * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span>
                {it.key && <span class="tag">{it.key}</span>}
                <button class="link small" onClick={() => forget(it.id, it.content)}>Oublier</button>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// --- Fichiers -----------------------------------------------------------------------------------------------------------
export function FilesPanel({ onOpen, refreshKey, onChanges }: { onOpen: (path: string) => void; refreshKey: number; onChanges: () => void }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [root, setRoot] = useState("");
  const [onlyRecent, setOnlyRecent] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api.files().then((r) => { setFiles(r.files); setRoot(r.root); }).catch((e) => setError(e.message)); }, [refreshKey]);
  const shown = (files ?? []).filter((f) => !onlyRecent || f.recent);
  const recent = (files ?? []).filter((f) => f.recent).length;
  return (
    <div class="files">
      <p class="explain-small" title={root}>Dossier de travail : <code>{root}</code></p>
      <div class="seg small">
        <button class={!onlyRecent ? "on" : ""} onClick={() => setOnlyRecent(false)}>Tous ({files?.length ?? 0})</button>
        <button class={onlyRecent ? "on" : ""} onClick={() => setOnlyRecent(true)}title="Modifiés depuis le début de la conversation">Modifiés ({recent})</button>
      </div>
      <button class="btn" onClick={onChanges}><span class="ico">{I.diff}</span> Toutes les modifications (diff, tout annuler)</button>
      {error && <p class="err small">{error}</p>}
      {files && shown.length === 0 && <p class="muted small pad0">{onlyRecent ? "Aucun fichier modifié pour l'instant." : "Dossier vide : demandez à l'IA de créer des fichiers."}</p>}
      <div class="file-list">
        {shown.map((f) => {
          const parts = f.path.split("/");
          return (
            <button key={f.path} class="file" onClick={() => onOpen(f.path)} title={f.path}>
              <span class="ico">{/\.(png|jpe?g|gif|webp|svg)$/i.test(f.path) ? I.image : I.fileCode}</span>
              <span class="f-name">{parts[parts.length - 1]}{parts.length > 1 && <span class="f-dir">{parts.slice(0, -1).join("/")}/</span>}</span>
              {f.recent && <span class="tag green">modifié</span>}
              <span class="f-size">{size(f.size)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const EXT_LANG: Record<string, string> = { py: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", rs: "rust", kt: "kotlin",
  json: "json", md: "markdown", sh: "bash", css: "css", html: "xml", xml: "xml", yml: "yaml", yaml: "yaml", toml: "ini", java: "java", go: "go", c: "c", cpp: "cpp", sql: "sql" };

export function FilePreviewModal({ path, onClose }: { path: string; onClose: () => void }) {
  const [f, setF] = useState<FilePreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.file(path).then(setF).catch((e) => setError(e.message)); }, [path]);
  const html = useMemo(() => {
    if (!f?.text) return "";
    const lang = EXT_LANG[path.split(".").pop()?.toLowerCase() ?? ""];
    try { return lang ? hljs.highlight(f.text, { language: lang }).value : hljs.highlightAuto(f.text).value; } catch { return ""; }
  }, [f]);
  return (
    <Modal title={path} icon={I.fileCode} onClose={onClose} wide>
      {error && <p class="err">{error}</p>}
      {!f && !error && <p class="muted">Chargement…</p>}
      {f?.image && <img class="preview-img" src={f.image} alt={path} />}
      {f?.binary && <p class="muted">Fichier binaire ({size(f.size)}) : pas d'aperçu.</p>}
      {f?.text !== undefined && (
        <div class="code preview"><div class="code-bar"><span>{size(f.size)}{f.truncated ? " · aperçu tronqué" : ""}</span>
          <button class="copy" onClick={() => navigator.clipboard.writeText(f.text ?? "")}>Copier</button></div>
          <pre><code class="hljs" dangerouslySetInnerHTML={{ __html: html || escapeHtml(f.text) }} /></pre></div>
      )}
    </Modal>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

// --- Palette de commandes (Ctrl+K) --------------------------------------------------------------------------------------
export interface Command { id: string; label: string; hint?: string; icon: string; run: () => void; enabled?: boolean }

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = commands.filter((c) => c.enabled !== false && c.label.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => setSel(0), [q]);
  const run = (c?: Command) => { if (c) { onClose(); c.run(); } };
  return (
    <div class="overlay top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-label="Commandes">
        <input ref={(el) => el?.focus()} placeholder="Que voulez-vous faire ?" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, list.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") run(list[sel]);
          }} />
        <div class="pal-list">
          {list.map((c, i) => (
            <button key={c.id} class={`pal-item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span class="ico">{c.icon}</span><span class="pal-label">{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
          {list.length === 0 && <p class="muted small pad">Aucune commande.</p>}
        </div>
      </div>
    </div>
  );
}

// --- Modifications de la discussion : diff global depuis le début, « Tout annuler » ------------------------------------
export function ChangesModal({ onClose, ask, onReverted }: {
  onClose: () => void; ask: (s: Omit<DialogSpec, "resolve">) => Promise<string | boolean | null>; onReverted: (n: number) => void;
}) {
  const [c, setC] = useState<Changes | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const load = () => api.changes().then(setC).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const revert = async () => {
    if (!c) return;
    const ok = await ask({ title: "Tout annuler ?", danger: true, confirm: `Annuler ${c.files.length} modification(s)`,
      message: "Les fichiers du dossier reviennent à leur état du début de la conversation : fichiers créés supprimés, fichiers modifiés ou supprimés restaurés. La conversation, elle, est conservée." });
    if (!ok) return;
    setWorking(true);
    try { const r = await api.revertAll(); onReverted(r.touched.length); await load(); }
    catch (e: any) { setError(e.message); } finally { setWorking(false); }
  };
  const label: Record<string, string> = { A: "créé", M: "modifié", D: "supprimé" };
  return (
    <Modal title="Modifications de la discussion" icon={I.diff} onClose={onClose} wide>
      {error && <p class="err">{error}</p>}
      {!c && !error && <p class="muted">Calcul des différences…</p>}
      {c && !c.available && <p class="muted">{c.reason ?? "Instantanés indisponibles pour ce dossier."}</p>}
      {c && c.available && (
        <>
          <p class="muted small">Depuis le début de la conversation{c.shadow ? " (suivi par un dépôt fantôme dans les données d'Eclipse : rien n'est écrit dans votre dossier)" : " (instantanés Git, sans commit ni modification de votre dépôt)"}.</p>
          {c.files.length === 0 ? <p>Aucune modification.</p> : (
            <>
              <div class="change-list">{c.files.map((f) => (
                <span key={f.path} class={`chg ${f.status}`}><b>{label[f.status] ?? f.status}</b> {f.path}</span>))}</div>
              <DiffView diff={c.diff} />
              {c.truncated && <p class="muted small">Diff tronqué à l'affichage (fichiers volumineux).</p>}
              <div class="row-end"><button class="btn primary danger" disabled={working} onClick={revert}>{working ? "Annulation…" : "Tout annuler"}</button></div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// --- Suggestions de la zone de saisie (@fichier, /commande) -----------------------------------------------------------
export interface Suggestion { key: string; label: string; detail?: string; icon: string; warn?: string }

export function Suggest({ items, sel, onPick }: { items: Suggestion[]; sel: number; onPick: (s: Suggestion) => void }) {
  if (items.length === 0) return null;
  return (
    <div class="suggest" role="listbox">
      {items.map((s, i) => (
        <button key={s.key} role="option" aria-selected={i === sel} class={`sg ${i === sel ? "on" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(s); }}>
          <span class="ico">{s.icon}</span><span class="sg-label">{s.label}</span>
          {s.warn ? <span class="tag amber">{s.warn}</span> : s.detail ? <span class="sg-detail">{s.detail}</span> : null}
        </button>
      ))}
    </div>
  );
}
