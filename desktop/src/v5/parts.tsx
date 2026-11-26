/** Éléments de l'interface : barre latérale, fil, outils, /cg, saisie, barre d'état, colonne de droite. */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EngineState, MediaModel, SessionRow, Space } from "./api";
import { chartHtml, parseChart } from "./chart";
import { I, TOOL_ICON } from "./icons";
import { chartsIn, mediaIn, renderMarkdown } from "./markdown";
import { CG_LABEL, msgText, type Block, type CgAgentId, type Msg, type Sub, type ThreadState } from "./thread";

export const SPACES: { id: Space; label: string; icon: string; hint: string }[] = [
  { id: "conversation", label: "Conversation", icon: I.chat, hint: "Discuter, chercher, appeler" },
  { id: "work", label: "Work", icon: I.work, hint: "Coder dans un projet, agents, /cg" },
  { id: "medias", label: "Médias", icon: I.media, hint: "Images, vidéos, sons" },
];

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));

// ------------------------------------------------------------------ barre latérale
function groupOf(last: number): string {
  const d = new Date(last * 1000), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  return diff < 1 ? "Aujourd'hui" : diff < 2 ? "Hier" : diff < 7 ? "7 derniers jours" : diff < 30 ? "30 derniers jours" : "Plus ancien";
}

export function Sidebar(p: {
  st: EngineState; sessions: SessionRow[]; space: Space; onSpace: (s: Space) => void; onNew: () => void; onOpen: (s: SessionRow) => void;
  onUsage: () => void; onSettings: () => void; onProjects: () => void; collapsed: boolean; onCollapse: () => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    return p.sessions.filter((s) => s.space === p.space && (!f || s.title.toLowerCase().includes(f))).slice(0, 200);
  }, [p.sessions, p.space, q]);
  const groups = useMemo(() => {
    const g: [string, SessionRow[]][] = [];
    for (const s of list) {
      const k = groupOf(s.last);
      const cur = g.find((x) => x[0] === k);
      if (cur) cur[1].push(s);
      else g.push([k, [s]]);
    }
    return g;
  }, [list]);
  if (p.collapsed)
    return (
      <aside class="side collapsed">
        <button class="icon-btn" title="Ouvrir la barre latérale" onClick={p.onCollapse}>{I.menu}</button>
        <button class="icon-btn" title="Nouvelle discussion" onClick={p.onNew}>{I.plus}</button>
        {SPACES.map((s) => (
          <button class={`icon-btn ${p.space === s.id ? "on" : ""}`} title={s.label} onClick={() => p.onSpace(s.id)}>{s.icon}</button>
        ))}
      </aside>
    );
  return (
    <aside class="side">
      <div class="brand">
        <span class="logo">{I.eclipse}</span>
        <span class="name">Eclipse</span>
        <button class="icon-btn ghost" title="Réduire" onClick={p.onCollapse}>{I.menu}</button>
      </div>
      <nav class="spaces" role="tablist">
        {SPACES.map((s) => (
          <button role="tab" aria-selected={p.space === s.id} class={`space ${p.space === s.id ? "on" : ""}`} title={s.hint} onClick={() => p.onSpace(s.id)}>
            <span class="ic">{s.icon}</span>{s.label}
          </button>
        ))}
      </nav>
      <button class="new-chat" onClick={p.onNew}><span class="ic">{I.plus}</span>Nouvelle discussion</button>
      {p.space === "work" && (
        <button class="project-chip" onClick={p.onProjects} title={p.st.cwd}>
          <span class="ic">{I.folder}</span>
          <span class="txt">{p.st.needsProject ? "Choisir un projet" : p.st.cwdShort.split("/").pop()}</span>
          <span class="ic dim">{I.chevron}</span>
        </button>
      )}
      <label class="search">
        <span class="ic">{I.search}</span>
        <input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Rechercher" aria-label="Rechercher dans les discussions" />
      </label>
      <div class="sessions">
        {!groups.length && <p class="empty">{q ? "Aucune discussion trouvée." : "Vos discussions apparaîtront ici."}</p>}
        {groups.map(([g, rows]) => (
          <section>
            <h4>{g}</h4>
            {rows.map((s) => (
              <button class={`session ${p.st.conv === s.id ? "on" : ""}`} onClick={() => p.onOpen(s)} title={s.title}>
                {s.cg && <span class="cg-tag">cg</span>}<span class="t">{s.title}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
      <div class="side-foot">
        <button class="foot-btn" onClick={p.onUsage}><span class="ic">{I.chart}</span>Consommation</button>
        <button class="foot-btn" onClick={p.onSettings}><span class="ic">{I.cog}</span>Réglages</button>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ fil
function ToolRow({ b }: { b: Extract<Block, { k: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const cls = !b.done ? "run" : b.ok === false ? "bad" : "ok";
  return (
    <div class={`tool ${cls}`}>
      <button class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="ic">{!b.done ? <span class="spin" /> : TOOL_ICON[b.name] ?? I.tool}</span>
        <span class="name">{b.name}</span>
        <span class="sum">{b.summary}</span>
        {(b.output || b.diff) && <span class="ic chev">{I.chevron}</span>}
      </button>
      {open && b.diff && (
        <pre class="diff">{b.diff.split("\n").map((l) => <span class={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l + "\n"}</span>)}</pre>
      )}
      {open && b.output && !b.diff && <pre class="out">{b.output}</pre>}
    </div>
  );
}

function Blocks({ blocks, final }: { blocks: Block[]; final?: string }) {
  return (
    <>
      {blocks.map((b) =>
        b.k === "text" ? <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text) }} />
        : b.k === "thinking" ? <details class="thinking"><summary><span class="ic">{I.brain}</span>Réflexion</summary><p>{b.text}</p></details>
        : b.k === "tool" ? <ToolRow b={b} />
        : <div class={`notice ${b.level}`}><span class="ic">{b.level === "error" ? I.alert : I.check}</span>{b.text}</div>,
      )}
      {final ? <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(final) }} /> : null}
    </>
  );
}

export function MessageView({ m, busy }: { m: Msg; busy: boolean }) {
  if (m.role === "user") return <div class="msg user"><div class="bubble">{m.text}</div></div>;
  const working = !m.done && busy;
  const empty = !m.blocks.length && !m.text;
  return (
    <div class="msg bot">
      <div class="avatar" aria-hidden="true">{I.eclipse}</div>
      <div class="body">
        {empty && working && <div class="typing"><span /><span /><span /><em>{m.cg ? "Claude Code et Codex travaillent…" : "Réflexion…"}</em></div>}
        <Blocks blocks={m.cg ? m.blocks.filter((b) => b.k !== "text") : m.blocks} final={m.text} />
        {m.done && (
          <div class="msg-foot">
            {m.interrupted ? "interrompu · " : ""}{m.seconds ? `${m.seconds.toFixed(1)} s` : ""}{m.tokens ? ` · ${fmtTok(m.tokens)} tokens` : ""}
            <button class="mini" title="Copier la réponse" onClick={() => navigator.clipboard?.writeText(msgText(m)).catch(() => {})}>{I.copy}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Welcome({ space, st, onPick }: { space: Space; st: EngineState; onPick: (t: string) => void }) {
  const h = new Date().getHours();
  const hello = h < 5 ? "Bonne nuit" : h < 18 ? "Bonjour" : "Bonsoir";
  const ideas: Record<Space, string[]> = {
    conversation: ["Explique-moi la différence entre TCP et UDP", "Compare l'évolution du prix de l'électricité en France depuis 2015 avec un graphique", "Aide-moi à préparer un entretien"],
    work: ["Fais un snake jouable dans le terminal", "Relis ce projet et propose 3 améliorations", "Écris les tests qui manquent"],
    medias: ["Une affiche rétro-futuriste pour un concert d'électro", "Une boucle musicale lo-fi de 30 secondes", "Un plan de drone au-dessus d'une ville au lever du soleil"],
  };
  return (
    <div class="welcome">
      <div class="hello"><span class="logo">{I.eclipse}</span><h1>{hello}</h1></div>
      <p class="sub">{space === "work" ? (st.needsProject ? "Choisissez un projet pour commencer : chaque projet a son dossier dans ~/Projets." : `Projet : ${st.cwdShort}`) : space === "medias" ? "Décrivez l'image, la vidéo ou le son à créer." : "De quoi voulez-vous parler ?"}</p>
      <div class="ideas">{ideas[space].map((t) => <button class="idea" onClick={() => onPick(t)}>{t}</button>)}</div>
    </div>
  );
}

// ------------------------------------------------------------------ /cg : onglets agents et sous-agents
const STATUS_CLASS = (s: string) => (/travaille|corrige|coordonne|relit/.test(s) ? "busy" : /échec/.test(s) ? "bad" : /terminé|approuvé/.test(s) ? "ok" : "idle");

function ZoneCard({ id, t, compact, onSub }: { id: CgAgentId; t: ThreadState; compact?: boolean; onSub: (s: Sub) => void }) {
  const z = t.zones[id];
  const subs = t.subs.filter((s) => s.agent === id);
  const entries = compact ? z.entries.slice(-8) : z.entries;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [z.entries.length]);
  return (
    <div class={`zone z-${STATUS_CLASS(z.status)}`}>
      <div class="zone-head">
        <span class="ic">{I.robot}</span><b>{CG_LABEL[id]}</b>
        <span class={`zst s-${STATUS_CLASS(z.status)}`}>{STATUS_CLASS(z.status) === "busy" && <span class="spin" />}{z.status}</span>
      </div>
      {subs.length > 0 && (
        <div class="dots" aria-label="sous-agents">
          {subs.map((s) => <button class={`dot ${s.done ? (s.ok === false ? "bad" : "done") : "run"}`} style={{ "--c": s.color } as any} title={`${s.label} (${s.done ? "terminé" : "en cours"})`} onClick={() => onSub(s)} />)}
          <span class="dim">{subs.length} sous-agent(s)</span>
        </div>
      )}
      <div class="zone-log" ref={ref}>
        {!entries.length && <p class="dim">{z.status === "absent" ? "Non installé : /cg continue avec l'autre agent." : "En attente."}</p>}
        <Blocks blocks={entries} />
      </div>
    </div>
  );
}

export function CgPanel({ t, tab, setTab }: { t: ThreadState; tab: string; setTab: (s: string) => void }) {
  const tabs = [{ id: "ensemble", label: "Vue d'ensemble" }, { id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" },
    ...t.subs.map((s) => ({ id: `sub:${s.id}`, label: s.label, color: s.color, done: s.done }))];
  const sub = tab.startsWith("sub:") ? t.subs.find((s) => `sub:${s.id}` === tab) : undefined;
  return (
    <section class="cg">
      <div class="cg-tabs" role="tablist">
        {tabs.map((x: any) => (
          <button role="tab" aria-selected={tab === x.id} class={`cg-tab ${tab === x.id ? "on" : ""}`} onClick={() => setTab(x.id)}>
            {x.color && <i class={`dot-s ${x.done ? "done" : "run"}`} style={{ "--c": x.color } as any} />}{x.label}
          </button>
        ))}
      </div>
      {t.phase && <div class="cg-phase">{t.cgTurn && !/approuvé|Désaccord|verdict|répondu/i.test(t.phase) && <span class="spin" />}{t.phase}</div>}
      {tab === "ensemble" && <div class="cg-grid"><ZoneCard id="claude" t={t} compact onSub={(s) => setTab(`sub:${s.id}`)} /><ZoneCard id="codex" t={t} compact onSub={(s) => setTab(`sub:${s.id}`)} /></div>}
      {(tab === "claude" || tab === "codex") && <div class="cg-full"><ZoneCard id={tab} t={t} onSub={(s) => setTab(`sub:${s.id}`)} /></div>}
      {sub && (
        <div class="cg-full">
          <div class="zone" style={{ "--c": sub.color } as any}>
            <div class="zone-head"><i class={`dot-s ${sub.done ? "done" : "run"}`} style={{ "--c": sub.color } as any} /><b>{sub.label}</b><span class="dim">sous-agent de {CG_LABEL[sub.agent as CgAgentId] ?? sub.agent}</span>
              <span class={`zst s-${sub.done ? (sub.ok === false ? "bad" : "ok") : "busy"}`}>{!sub.done && <span class="spin" />}{sub.done ? (sub.ok === false ? "échec" : "terminé") : "travaille"}</span></div>
            <div class="zone-log"><Blocks blocks={sub.entries} />{sub.report && <><h5>Rapport rendu à l'agent</h5><div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(sub.report) }} /></>}</div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Points des sous-agents au-dessus de la saisie (agent seul ou /cg). */
export function SubDots({ subs, onOpen }: { subs: Sub[]; onOpen: (s: Sub) => void }) {
  if (!subs.length) return null;
  return (
    <div class="subdots">
      <span class="ic">{I.agents}</span>
      {subs.map((s) => <button class={`dot ${s.done ? (s.ok === false ? "bad" : "done") : "run"}`} style={{ "--c": s.color } as any} title={s.label} onClick={() => onOpen(s)}><span>{s.label}</span></button>)}
    </div>
  );
}

// ------------------------------------------------------------------ saisie
export function Composer(p: {
  st: EngineState; space: Space; busy: boolean; cgOn: boolean; setCgOn: (b: boolean) => void; onSend: (t: string) => void; onStop: () => void;
  onModels: () => void; onEffort: (v: string | null) => void; media: MediaModel[]; mediaModel: MediaModel | null; setMediaModel: (m: MediaModel | null) => void;
  voice: { state: string; call: boolean; level: number }; onDictate: () => void; onCall: () => void; draft: string; setDraft: (s: string) => void; history: string[];
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [hi, setHi] = useState(-1);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(260, el.scrollHeight) + "px";
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
  const effortLabel = p.st.effort ?? "auto";
  const listening = p.voice.state === "écoute" && !p.voice.call;
  const groups = ["image", "video", "audio", "?"].map((k) => [k, p.media.filter((m) => (k === "?" ? !m.output.some((o) => ["image", "video", "audio"].includes(o)) : m.output.includes(k)))] as const).filter((g) => g[1].length);
  return (
    <div class={`composer ${p.busy ? "busy" : ""}`}>
      <textarea ref={ta} rows={1} value={p.draft} onInput={(e) => p.setDraft((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey as any}
        placeholder={p.space === "medias" ? "Décrivez ce qu'il faut créer…" : p.space === "work" ? (p.cgOn ? "Demandez à Claude Code et Codex…" : "Que faut-il faire dans le projet ?") : "Écrivez votre message…"}
        aria-label="Message" />
      <div class="composer-bar">
        <div class="left">
          {p.space === "medias" ? (
            <select class="pill" value={p.mediaModel ? `${p.mediaModel.provider}/${p.mediaModel.id}` : ""} aria-label="Modèle de médias"
              onChange={(e) => { const v = (e.target as HTMLSelectElement).value; p.setMediaModel(p.media.find((m) => `${m.provider}/${m.id}` === v) ?? null); }}>
              <option value="">{p.media.length ? "Choisir un modèle de médias" : "Aucun modèle de médias (clé Poe ?)"}</option>
              {groups.map(([k, ms]) => (
                <optgroup label={k === "image" ? "Images" : k === "video" ? "Vidéo" : k === "audio" ? "Son" : "Autres"}>
                  {ms.map((m) => <option value={`${m.provider}/${m.id}`}>{m.id}</option>)}
                </optgroup>
              ))}
            </select>
          ) : (
            <button class="pill model" onClick={p.onModels} title="Changer de modèle">
              <span class="ic">{p.st.current?.kind === "agent" ? I.robot : I.sparkle}</span>{p.space === "work" && p.cgOn ? "Claude Code + Codex" : p.st.label}<span class="ic dim">{I.chevron}</span>
            </button>
          )}
          {p.space !== "medias" && !(p.space === "work" && p.cgOn) && p.st.efforts.length > 0 && (
            <select class="pill" value={p.st.effort ?? ""} onChange={(e) => p.onEffort((e.target as HTMLSelectElement).value || null)} aria-label="Effort" title="Effort de réflexion">
              <option value="">effort : auto</option>
              {p.st.efforts.map((x) => <option value={x}>effort : {x}</option>)}
            </select>
          )}
          {p.space === "work" && (
            <div class="seg" role="radiogroup" aria-label="Mode de travail">
              <button role="radio" aria-checked={!p.cgOn} class={!p.cgOn ? "on" : ""} onClick={() => p.setCgOn(false)}>{p.st.current?.kind === "agent" ? "Agent" : "Modèle"}</button>
              <button role="radio" aria-checked={p.cgOn} class={p.cgOn ? "on" : ""} onClick={() => p.setCgOn(true)} title="Claude Code et Codex ensemble"><span class="ic">{I.agents}</span>/cg</button>
            </div>
          )}
        </div>
        <div class="right">
          {p.space !== "medias" && (
            <>
              <button class={`icon-btn ${listening ? "rec" : ""}`} onClick={p.onDictate} title={listening ? "Écoute… (parlez)" : "Dicter"} aria-pressed={listening}>
                {listening ? <span class="level" style={{ "--l": String(Math.min(1, p.voice.level * 6)) } as any}>{I.wave}</span> : I.mic}
              </button>
              <button class={`icon-btn ${p.voice.call ? "call-on" : ""}`} onClick={p.onCall} title={p.voice.call ? "Raccrocher" : "Appel vocal"}>{p.voice.call ? I.hangup : I.phone}</button>
            </>
          )}
          {p.busy ? (
            <button class="send stop" onClick={p.onStop} title="Arrêter (Échap)">{I.stop}</button>
          ) : (
            <button class="send" onClick={send} disabled={!p.draft.trim()} title="Envoyer (Entrée)">{I.send}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ barre d'état (style terminal)
export function StatusBar({ st, today, connected }: { st: EngineState; today: number; connected: boolean }) {
  const mcpOn = st.mcp.filter((m) => m.state === "connecté").length;
  const waiting = st.mcp.filter((m) => m.state === "à approuver").length;
  return (
    <footer class="status">
      <span class={connected ? "ok" : "bad"}>{connected ? "● moteur" : "○ moteur déconnecté"}</span>
      <span title="Permissions">{I.shield} {st.perm}{st.perm.startsWith("bypass") ? " !" : ""}</span>
      <span class={st.sandbox ? "ok" : "warn"} title="Sandbox des commandes">{I.lock} {st.sandbox ? "sandbox" : "sans sandbox"}</span>
      <span title="Serveurs MCP connectés">{I.server} MCP {mcpOn}{waiting ? ` · ${waiting} à approuver` : ""}</span>
      <span title="Tokens aujourd'hui">{I.speed} {fmtTok(today)} aujourd'hui</span>
      <span class="cwd" title={st.cwd}>{I.folder} {st.cwdShort}</span>
    </footer>
  );
}

// ------------------------------------------------------------------ colonne de droite : graphiques, médias, tâches, sous-agents
export function Rail({ t, st, space, onClose, onMedia, onSub }: { t: ThreadState; st: EngineState; space: Space; onClose: () => void; onMedia: (u: string, k: string) => void; onSub: (s: Sub) => void }) {
  const texts = t.msgs.filter((m) => m.role === "assistant").map(msgText);
  const charts = texts.flatMap(chartsIn).map(parseChart).filter(Boolean).slice(-6);
  const media = texts.flatMap(mediaIn).slice(-24);
  return (
    <aside class="rail">
      <div class="rail-head"><b>Aperçu</b><button class="icon-btn ghost" onClick={onClose} title="Fermer">{I.close}</button></div>
      {space === "medias" && (
        <section>
          <h4>{I.media} Galerie</h4>
          {!media.length && <p class="dim">Les images, vidéos et sons créés s'afficheront ici.</p>}
          <div class="gallery">
            {media.map((m) => m.kind === "image" ? <button class="thumb" onClick={() => onMedia(m.url, m.kind)}><img src={m.url} alt="" loading="lazy" /></button>
              : m.kind === "video" ? <video class="thumb" src={m.url} controls preload="metadata" /> : <audio src={m.url} controls preload="metadata" />)}
          </div>
        </section>
      )}
      {space !== "medias" && (
        <section>
          <h4>{I.chart} Graphiques</h4>
          {!charts.length && <p class="dim">Demandez des chiffres « avec un graphique » : il apparaît dans la discussion et ici.</p>}
          {charts.map((c) => <div class="md" dangerouslySetInnerHTML={{ __html: chartHtml(c!) }} />)}
          {media.length > 0 && <><h4>{I.image} Images</h4><div class="gallery">{media.filter((m) => m.kind === "image").map((m) => <button class="thumb" onClick={() => onMedia(m.url, "image")}><img src={m.url} alt="" loading="lazy" /></button>)}</div></>}
        </section>
      )}
      {space === "work" && st.todos.length > 0 && (
        <section>
          <h4>{I.check} Tâches</h4>
          <ul class="todos">{st.todos.map((x) => <li class={x.status === "fait" ? "done" : x.status === "en cours" ? "doing" : ""}>{x.text}</li>)}</ul>
        </section>
      )}
      {t.subs.length > 0 && (
        <section>
          <h4>{I.agents} Sous-agents</h4>
          {t.subs.map((s) => <button class="sub-row" onClick={() => onSub(s)}><i class={`dot-s ${s.done ? "done" : "run"}`} style={{ "--c": s.color } as any} />{s.label}<span class="dim">{s.done ? (s.ok === false ? "échec" : "terminé") : "en cours"}</span></button>)}
        </section>
      )}
    </aside>
  );
}
