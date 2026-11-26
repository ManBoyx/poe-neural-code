/** Éléments de l'interface : barre latérale, fil, agents /cg, saisie, barre d'état, colonne de droite. */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EngineState, MediaModel, SessionRow, Space } from "./api";
import { chartHtml, parseChart } from "./chart";
import { I } from "./icons";
import { chartsIn, mediaIn, renderMarkdown } from "./markdown";
import { CG_LABEL, msgText, type Block, type CgAgentId, type Msg, type Sub, type ThreadState } from "./thread";

export const SPACES: { id: Space; label: string; icon: string; hint: string }[] = [
  { id: "conversation", label: "Discuter", icon: I.chat, hint: "Conversation : questions, recherches, graphiques" },
  { id: "work", label: "Travail", icon: I.work, hint: "Travail : coder dans un projet, agents, /cg" },
  { id: "medias", label: "Médias", icon: I.media, hint: "Médias : images, vidéos, sons" },
];

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(".", ",")} k` : String(n));
const Ic = ({ i }: { i: string }) => <span class="ic" aria-hidden="true">{i}</span>;

// ------------------------------------------------------------------ étapes en clair (ce que fait l'agent, pas comment)
const VERB: Record<string, [string, string]> = {
  read_file: ["Lit", I.file], Read: ["Lit", I.file], list_dir: ["Parcourt", I.folder], LS: ["Parcourt", I.folder],
  search_files: ["Cherche", I.search], Grep: ["Cherche", I.search], Glob: ["Cherche", I.search],
  write_file: ["Écrit", I.pencil], Write: ["Écrit", I.pencil], edit_file: ["Modifie", I.pencil], Edit: ["Modifie", I.pencil], MultiEdit: ["Modifie", I.pencil],
  fichiers: ["Modifie", I.pencil], run_command: ["Lance", I.console], Bash: ["Lance", I.console], commande: ["Lance", I.console],
  web_fetch: ["Consulte", I.search], WebFetch: ["Consulte", I.search], WebSearch: ["Recherche", I.search], recherche: ["Recherche", I.search],
  todo_write: ["Organise ses tâches", I.check], TodoWrite: ["Organise ses tâches", I.check], Agent: ["Confie une tâche", I.agents], Task: ["Confie une tâche", I.agents],
  skill: ["Utilise un savoir-faire", I.sparkle],
};
export function stepOf(b: Extract<Block, { k: "tool" }>): { verb: string; icon: string; obj: string } {
  const [verb, icon] = VERB[b.name] ?? (b.name.startsWith("mcp__") ? ["Utilise un outil", I.tool] : ["Agit", I.tool]);
  const obj = b.summary.replace(/^(add|update|delete)\s+/i, "").replace(/\s+/g, " ").slice(0, 90);
  return { verb, icon, obj };
}

/** Le plan interne du coordinateur (JSON) devient une phrase. */
function humanText(t: string): string {
  const m = t.trim().match(/^\{[\s\S]*\}$/);
  if (!m) return t;
  try {
    const j = JSON.parse(m[0]);
    if (j.simple) return String(j.answer ?? "");
    if (j.task) return `Plan : ${j.task}${j.writer ? ` (confié à ${CG_LABEL[j.writer as CgAgentId] ?? j.writer})` : ""}`;
  } catch { /* texte ordinaire */ }
  return t;
}

function Steps({ blocks, running }: { blocks: Block[]; running: boolean }) {
  const tools = blocks.filter((b) => b.k === "tool") as Extract<Block, { k: "tool" }>[];
  const thinking = blocks.filter((b) => b.k === "thinking");
  if (!tools.length && !thinking.length) return null;
  const cur = [...tools].reverse().find((t) => !t.done);
  const label = running && cur ? `${stepOf(cur).verb} ${stepOf(cur).obj}` : tools.length ? `${tools.length} étape${tools.length > 1 ? "s" : ""}` : "Réflexion";
  return (
    <details class="details">
      <summary class="press">{running && cur ? <span class="spin" /> : <Ic i={I.chevron} />}<span>{label}</span></summary>
      {thinking.map((b) => <p class="step"><Ic i={I.brain} /><span class="obj selectable">{(b as any).text.slice(-400)}</span></p>)}
      {tools.map((b) => <StepRow b={b} />)}
    </details>
  );
}

function StepRow({ b }: { b: Extract<Block, { k: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const s = stepOf(b);
  const more = !!(b.output || b.diff);
  return (
    <>
      <div class={`step ${!b.done ? "run" : b.ok === false ? "bad" : ""}`}>
        {!b.done ? <span class="spin" /> : <Ic i={b.ok === false ? I.alert : s.icon} />}
        <span class="what">{s.verb}</span><span class="obj">{s.obj}</span>
        {more && <button class="mini step-more press" onClick={() => setOpen(!open)} title={open ? "Masquer" : "Voir le détail"}><Ic i={I.chevron} /></button>}
      </div>
      {open && b.diff && <pre class="diff">{b.diff.split("\n").map((l) => <span class={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l + "\n"}</span>)}</pre>}
      {open && b.output && !b.diff && <pre class="out">{b.output}</pre>}
    </>
  );
}

// ------------------------------------------------------------------ barre latérale
function groupOf(last: number): string {
  const d = new Date(last * 1000), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  return diff < 1 ? "Aujourd'hui" : diff < 2 ? "Hier" : diff < 7 ? "7 derniers jours" : diff < 30 ? "30 derniers jours" : "Plus ancien";
}

export function Sidebar(p: {
  st: EngineState; sessions: SessionRow[]; space: Space; onSpace: (s: Space) => void; onNew: () => void; onOpen: (s: SessionRow) => void;
  onUsage: () => void; onSettings: () => void; onProjects: () => void; onCollapse: () => void;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const f = q.trim().toLowerCase();
    const g: [string, SessionRow[]][] = [];
    for (const s of p.sessions) {
      if (s.space !== p.space || (f && !s.title.toLowerCase().includes(f))) continue;
      const k = groupOf(s.last);
      const cur = g.find((x) => x[0] === k);
      if (cur) cur[1].push(s);
      else g.push([k, [s]]);
    }
    return g;
  }, [p.sessions, p.space, q]);
  return (
    <aside class="side" aria-label="Navigation">
      <div class="side-top">
        <span class="ic logo" aria-hidden="true">{I.eclipse}</span><span class="name">Eclipse</span>
        <button class="icon-btn press" title="Masquer la barre latérale (Ctrl+B)" onClick={p.onCollapse}><Ic i={I.menu} /></button>
      </div>
      <div class="segmented" role="tablist" aria-label="Espace">
        {SPACES.map((s) => (
          <button role="tab" aria-selected={p.space === s.id} class={`press ${p.space === s.id ? "on" : ""}`} title={s.hint} onClick={() => p.onSpace(s.id)}>{s.label}</button>
        ))}
      </div>
      <div>
        <button class="row-btn accent press" onClick={p.onNew}><Ic i={I.pencil} /><span class="grow">Nouvelle discussion</span></button>
        {p.space === "work" && (
          <button class="row-btn press" onClick={p.onProjects} title={p.st.cwd}>
            <Ic i={I.folder} /><span class="grow">{p.st.needsProject ? "Choisir un projet" : p.st.cwdShort.split("/").pop()}</span>
          </button>
        )}
      </div>
      <label class="field"><Ic i={I.search} /><input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Rechercher" aria-label="Rechercher dans les discussions" /></label>
      <div class="sessions">
        {!groups.length && <p class="empty">{q ? "Aucun résultat." : "Aucune discussion pour l'instant."}</p>}
        {groups.map(([g, rows]) => (
          <section>
            <h4>{g}</h4>
            {rows.map((s) => (
              <button class={`session press ${p.st.conv === s.id ? "on" : ""}`} onClick={() => p.onOpen(s)} title={s.title}>
                <span class="t">{s.title}</span>{s.cg && <span class="tag">/cg</span>}
              </button>
            ))}
          </section>
        ))}
      </div>
      <div class="side-foot">
        <button class="row-btn press" onClick={p.onUsage}><Ic i={I.chart} /><span class="grow">Consommation</span></button>
        <button class="row-btn press" onClick={p.onSettings}><Ic i={I.cog} /><span class="grow">Réglages</span></button>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ fil
export function MessageView({ m, busy }: { m: Msg; busy: boolean }) {
  if (m.role === "user") return <div class="msg user"><div class="bubble">{m.text}</div></div>;
  const running = !m.done && busy;
  const texts = m.blocks.filter((b) => b.k === "text") as Extract<Block, { k: "text" }>[];
  const notices = m.blocks.filter((b) => b.k === "notice") as Extract<Block, { k: "notice" }>[];
  const shown = m.cg ? m.text : texts.map((b) => b.text).join("") || m.text;
  return (
    <div class="msg bot">
      <div class="body">
        {!m.cg && <Steps blocks={m.blocks} running={running} />}
        {!shown && running && <div class="typing" aria-label="En cours"><span /><span /><span /><em>{m.cg ? "Les agents travaillent…" : ""}</em></div>}
        {shown && <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown) }} />}
        {notices.filter((n) => n.level === "error").map((n) => <p class="notice error"><Ic i={I.alert} />{n.text}</p>)}
        {m.done && (
          <div class="msg-foot">
            <button class="mini press" title="Copier la réponse" onClick={() => navigator.clipboard?.writeText(msgText(m)).catch(() => {})}><Ic i={I.copy} /></button>
            <span>{m.interrupted ? "Interrompu · " : ""}{m.seconds ? `${m.seconds.toFixed(1).replace(".", ",")} s` : ""}{m.tokens ? ` · ${fmtTok(m.tokens)} tokens` : ""}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function Welcome({ space, st, onPick }: { space: Space; st: EngineState; onPick: (t: string) => void }) {
  const ideas: Record<Space, string[]> = {
    conversation: ["Explique-moi la différence entre TCP et UDP", "Compare le prix de l'électricité en France depuis 2015, avec un graphique", "Aide-moi à préparer un entretien d'embauche"],
    work: ["Fais un snake jouable dans le terminal", "Relis ce projet et propose trois améliorations", "Écris les tests qui manquent"],
    medias: ["Une affiche rétro-futuriste pour un concert d'électro", "Une boucle musicale lo-fi de trente secondes", "Un plan de drone au-dessus d'une ville au lever du soleil"],
  };
  const title = space === "work" ? "Sur quoi travaille-t-on ?" : space === "medias" ? "Que faut-il créer ?" : "Comment puis-je t'aider ?";
  const sub = space === "work" ? (st.needsProject ? "Choisis d'abord un projet : chacun a son dossier dans ~/Projets." : `Projet : ${st.cwdShort.split("/").pop()}`)
    : space === "medias" ? "Image, vidéo ou son, avec le modèle choisi en bas." : "";
  return (
    <div class="welcome">
      <h1>{title}</h1>
      {sub ? <p class="lead">{sub}</p> : <div style={{ height: "22px" }} />}
      <div class="ideas">{ideas[space].map((t) => <button class="idea press" onClick={() => onPick(t)}>{t}</button>)}</div>
    </div>
  );
}

// ------------------------------------------------------------------ /cg : les agents et ce qu'ils font
const STATUS = (s: string): "busy" | "ok" | "bad" | "idle" => (/travaille|corrige|coordonne|relit/.test(s) ? "busy" : /échec/.test(s) ? "bad" : /terminé|approuvé/.test(s) ? "ok" : "idle");
const STATUS_LABEL = (s: string, installed: boolean) => (!installed ? "Non installé" : s === "en attente" || !s ? "Prêt" : s === "absent" ? "Absent" : s.charAt(0).toUpperCase() + s.slice(1));

function activityOf(t: ThreadState, id: CgAgentId): string {
  const z = t.zones[id];
  const last = z.entries[z.entries.length - 1];
  if (!last) return STATUS(z.status) === "busy" ? "Démarre…" : t.msgs.length ? "Rien à faire pour l'instant" : "Attend ta demande";
  if (last.k === "tool") { const s = stepOf(last); return `${s.verb} ${s.obj}`; }
  if (last.k === "text") return humanText(last.text).split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
  if (last.k === "thinking") return "Réfléchit…";
  return last.text;
}

export function AgentsStrip({ st, t, open, onOpen }: { st: EngineState; t: ThreadState; open: string | null; onOpen: (key: string) => void }) {
  return (
    <section class="agents" aria-label="Agents">
      {(["claude", "codex"] as CgAgentId[]).map((id) => {
        const info = st.agents.find((a) => a.id === id);
        const installed = !!info?.installed;
        const z = t.zones[id];
        const stc = installed ? STATUS(z.status) : "idle";
        const model = st.cg.agents[id]?.model;
        const subs = t.subs.filter((s) => s.agent === id);
        return (
          <div class={`agent ${stc} ${open === id ? "on" : ""}`}>
            <button class="av press" onClick={() => onOpen(id)} title={`Voir ce que fait ${CG_LABEL[id]}`}><Ic i={I.robot} /></button>
            <button class="nm" onClick={() => onOpen(id)} style={{ textAlign: "left" }}>{CG_LABEL[id]}{model && <span class="model">{model}</span>}{st.cg.lead === id && <span class="tag">coordinateur</span>}</button>
            <span class="st"><i class={`dot ${stc}`} />{STATUS_LABEL(z.status, installed)}</span>
            <span class="act">{installed ? activityOf(t, id) : "Installe-le pour qu'il participe"}</span>
            {subs.length > 0 && (
              <div class="subs">
                {subs.map((s) => <button class="sub press" onClick={() => onOpen(`sub:${s.id}`)} title={s.label}><i class={s.done ? "" : "run"} style={{ "--c": s.color } as any} /><span>{s.label}</span></button>)}
              </div>
            )}
          </div>
        );
      })}
      {t.phase && t.cgTurn && <div class="phase">{!/approuvé|Désaccord|verdict|répondu|Réponse/i.test(t.phase) && <span class="spin" />}{t.phase}</div>}
    </section>
  );
}

/** Panneau d'un agent ou d'un sous-agent : ce qu'il a dit et fait, en clair. */
export function AgentSheet({ t, which, onClose }: { t: ThreadState; which: string | null; onClose: () => void }) {
  const sub = which?.startsWith("sub:") ? t.subs.find((s) => `sub:${s.id}` === which) : undefined;
  const id = !sub && (which === "claude" || which === "codex") ? which : null;
  const entries: Block[] = sub ? sub.entries : id ? t.zones[id].entries : [];
  const title = sub ? sub.label : id ? CG_LABEL[id] : "";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [entries.length, which]);
  // texte en clair, étapes regroupées entre deux messages
  const parts: ({ k: "text"; text: string } | { k: "steps"; items: Block[] })[] = [];
  for (const b of entries) {
    if (b.k === "text" && b.text.trim()) parts.push({ k: "text", text: humanText(b.text) });
    else if (b.k === "tool" || b.k === "thinking") {
      const last = parts[parts.length - 1];
      if (last && last.k === "steps") last.items.push(b);
      else parts.push({ k: "steps", items: [b] });
    }
  }
  return (
    <aside class={`sheet ${which ? "" : "closed"}`} aria-hidden={!which} aria-label={title}>
      <div class="sheet-head">
        {sub ? <i class="dot" style={{ background: sub.color }} /> : <Ic i={I.robot} />}
        <h3>{title}{sub && <span class="dim" style={{ fontWeight: 400 }}> · sous-agent de {CG_LABEL[sub.agent as CgAgentId] ?? sub.agent}</span>}</h3>
        <button class="icon-btn press" onClick={onClose} aria-label="Fermer"><Ic i={I.close} /></button>
      </div>
      <div class="sheet-body" ref={ref}>
        {!parts.length && <p class="dim">Rien pour l'instant.</p>}
        {parts.map((p) => (p.k === "text" ? <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} /> : <Steps blocks={p.items} running={p.items.some((b) => b.k === "tool" && !b.done)} />))}
        {sub?.report && <><h5>Rapport rendu</h5><div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(sub.report) }} /></>}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ saisie
export function Composer(p: {
  st: EngineState; space: Space; busy: boolean; cgOn: boolean; setCgOn: (b: boolean) => void; onSend: (t: string) => void; onStop: () => void;
  onModels: () => void; onEffort: (v: string | null) => void; media: MediaModel[]; mediaModel: MediaModel | null; setMediaModel: (m: MediaModel | null) => void;
  voice: { state: string; level: number }; onDictate: () => void; onStopDictate: () => void; draft: string; setDraft: (s: string) => void; history: string[];
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [hi, setHi] = useState(-1);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(240, el.scrollHeight) + "px";
  }, [p.draft]);
  useEffect(() => { ta.current?.focus(); }, [p.space]);
  const send = () => {
    if (!p.draft.trim() || p.busy) return;
    p.onSend(p.draft);
    setHi(-1);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    // ↑ ↓ dans une saisie vide (ou déjà dans l'historique) : messages précédents
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (!p.draft || hi >= 0) && p.history.length) {
      e.preventDefault();
      const n = e.key === "ArrowUp" ? Math.min(p.history.length - 1, hi + 1) : hi - 1;
      setHi(n);
      p.setDraft(n >= 0 ? p.history[n] : "");
    }
  };
  const listening = p.voice.state === "écoute";
  const transcribing = p.voice.state === "transcription";
  // générateurs purs d'abord (image, vidéo, son), puis les modèles de texte qui savent aussi créer des médias
  const pure = (m: MediaModel) => !m.output.includes("text");
  const groups: [string, MediaModel[]][] = [
    ["Images", p.media.filter((m) => pure(m) && m.output.includes("image"))],
    ["Vidéo", p.media.filter((m) => pure(m) && m.output.includes("video"))],
    ["Son", p.media.filter((m) => pure(m) && m.output.includes("audio"))],
    ["Texte et médias", p.media.filter((m) => !pure(m))],
  ].filter((g) => (g[1] as MediaModel[]).length) as [string, MediaModel[]][];
  return (
    <div class="composer">
      {listening || transcribing ? (
        <div class="listening" role="status">
          <span class="meter" style={{ "--l": String(Math.min(1, p.voice.level * 6)) } as any}><i /><i /><i /></span>
          {listening ? "Je t'écoute… (le texte s'écrit quand tu t'arrêtes de parler)" : "Transcription…"}
        </div>
      ) : (
        <textarea ref={ta} rows={1} value={p.draft} onInput={(e) => p.setDraft((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey as any}
          placeholder={p.space === "medias" ? "Décris ce qu'il faut créer" : p.space === "work" ? (p.cgOn ? "Demande à Claude Code et Codex" : "Que faut-il faire dans le projet ?") : "Écris ton message"}
          aria-label="Message" />
      )}
      <div class="composer-bar">
        {p.space === "medias" ? (
          <select class="chip-btn" value={p.mediaModel ? `${p.mediaModel.provider}/${p.mediaModel.id}` : ""} aria-label="Modèle de médias"
            onChange={(e) => { const v = (e.target as HTMLSelectElement).value; p.setMediaModel(p.media.find((m) => `${m.provider}/${m.id}` === v) ?? null); }}>
            <option value="">{p.media.length ? "Choisir un modèle" : "Aucun modèle de médias"}</option>
            {groups.map(([k, ms]) => (
              <optgroup label={k}>
                {ms.map((m) => <option value={`${m.provider}/${m.id}`}>{m.id}</option>)}
              </optgroup>
            ))}
          </select>
        ) : !(p.space === "work" && p.cgOn) ? (
          <button class="chip-btn press" onClick={p.onModels} title="Changer de modèle (Ctrl+K)"><span class="lbl">{p.st.label}</span><Ic i={I.chevron} /></button>
        ) : (
          <span class="chip-btn" style={{ cursor: "default" }}><span class="lbl">Claude Code et Codex</span></span>
        )}
        {p.space !== "medias" && !(p.space === "work" && p.cgOn) && p.st.efforts.length > 0 && (
          <select class="chip-btn" value={p.st.effort ?? ""} onChange={(e) => p.onEffort((e.target as HTMLSelectElement).value || null)} aria-label="Effort de réflexion">
            <option value="">Effort auto</option>
            {p.st.efforts.map((x) => <option value={x}>Effort {x}</option>)}
          </select>
        )}
        {p.space === "work" && (
          <div class="mini-seg" role="radiogroup" aria-label="Mode de travail">
            <button role="radio" aria-checked={!p.cgOn} class={`press ${!p.cgOn ? "on" : ""}`} onClick={() => p.setCgOn(false)}>{p.st.current?.kind === "agent" ? "Agent" : "Modèle"}</button>
            <button role="radio" aria-checked={p.cgOn} class={`press ${p.cgOn ? "on" : ""}`} onClick={() => p.setCgOn(true)} title="Claude Code et Codex ensemble">/cg</button>
          </div>
        )}
        <span class="grow" />
        {p.space !== "medias" && (
          listening || transcribing
            ? <button class="icon-btn rec press" onClick={p.onStopDictate} title="Arrêter la dictée"><Ic i={I.stop} /></button>
            : <button class="icon-btn press" onClick={p.onDictate} title="Dicter (ta voix devient du texte)" disabled={p.busy}><Ic i={I.mic} /></button>
        )}
        {p.busy ? (
          <button class="send stop press" onClick={p.onStop} title="Arrêter (Échap)"><Ic i={I.stop} /></button>
        ) : (
          <button class="send press" onClick={send} disabled={!p.draft.trim()} title="Envoyer (Entrée)"><Ic i={I.send} /></button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ barre d'état
export function StatusBar({ st, today, connected }: { st: EngineState; today: number; connected: boolean }) {
  const mcpOn = st.mcp.filter((m) => m.state === "connecté").length;
  const waiting = st.mcp.filter((m) => m.state === "à approuver").length;
  return (
    <footer class="status">
      {!connected && <span class="bad">Moteur déconnecté</span>}
      <span title="Permissions"><Ic i={I.shield} />{st.perm === "demander" ? "Tout confirmer" : st.perm}</span>
      <span class={st.sandbox ? "" : "warn"} title="Sandbox des commandes"><Ic i={I.lock} />{st.sandbox ? "Sandbox" : "Sans sandbox"}</span>
      {(mcpOn > 0 || waiting > 0) && <span title="Serveurs MCP"><Ic i={I.server} />MCP {mcpOn}{waiting ? ` · ${waiting} à approuver` : ""}</span>}
      <span title="Tokens utilisés aujourd'hui">{fmtTok(today)} tokens aujourd'hui</span>
      <span class="cwd" title={st.cwd}>{st.cwdShort}</span>
    </footer>
  );
}

// ------------------------------------------------------------------ colonne de droite : graphiques, médias, tâches
export function Rail({ t, st, space, onClose, onMedia }: { t: ThreadState; st: EngineState; space: Space; onClose: () => void; onMedia: (u: string) => void }) {
  const texts = t.msgs.filter((m) => m.role === "assistant").map(msgText);
  const charts = texts.flatMap(chartsIn).map((c) => { try { return parseChart(c); } catch { return null; } }).filter(Boolean).slice(-6);
  const media = texts.flatMap(mediaIn).slice(-24);
  const images = media.filter((m) => m.kind === "image");
  return (
    <aside class="rail" aria-label="Aperçu">
      <div class="rail-head"><b>Aperçu</b><button class="icon-btn press" onClick={onClose} title="Fermer"><Ic i={I.close} /></button></div>
      {space === "medias" ? (
        <section>
          <h4><Ic i={I.media} />Galerie</h4>
          {!media.length && <p class="dim small">Les images, vidéos et sons créés s'afficheront ici.</p>}
          <div class="gallery">
            {media.map((m) => m.kind === "image" ? <button class="thumb press" onClick={() => onMedia(m.url)}><img src={m.url} alt="" loading="lazy" /></button>
              : m.kind === "video" ? <video class="thumb" src={m.url} controls preload="metadata" /> : <audio src={m.url} controls preload="metadata" />)}
          </div>
        </section>
      ) : (
        <section>
          <h4><Ic i={I.chart} />Graphiques</h4>
          {!charts.length && <p class="dim small">Demande des chiffres « avec un graphique » : il apparaît dans la discussion et ici.</p>}
          {charts.map((c) => <div class="md" dangerouslySetInnerHTML={{ __html: chartHtml(c!) }} />)}
          {images.length > 0 && <><h4><Ic i={I.image} />Images</h4><div class="gallery">{images.map((m) => <button class="thumb press" onClick={() => onMedia(m.url)}><img src={m.url} alt="" loading="lazy" /></button>)}</div></>}
        </section>
      )}
      {space === "work" && st.todos.length > 0 && (
        <section>
          <h4><Ic i={I.check} />Tâches</h4>
          <ul class="todos">{st.todos.map((x) => <li class={x.status === "fait" ? "done" : x.status === "en cours" ? "doing" : ""}>{x.text}</li>)}</ul>
        </section>
      )}
    </aside>
  );
}

export const railHasContent = (t: ThreadState) => t.msgs.some((m) => m.role === "assistant" && (chartsIn(msgText(m)).length > 0 || mediaIn(msgText(m)).length > 0));
