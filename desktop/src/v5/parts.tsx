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

function Steps({ blocks, running, showThinking = true }: { blocks: Block[]; running: boolean; showThinking?: boolean }) {
  const tools = blocks.filter((b) => b.k === "tool") as Extract<Block, { k: "tool" }>[];
  const thinking = blocks.filter((b) => b.k === "thinking");
  if (!tools.length && !thinking.length) return null;
  if (!tools.length && !showThinking) return null;
  const cur = [...tools].reverse().find((t) => !t.done);
  const label = running && cur ? `${stepOf(cur).verb} ${stepOf(cur).obj}` : tools.length ? `${tools.length} étape${tools.length > 1 ? "s" : ""}` : "Réflexion";
  return (
    <details class="details">
      <summary class="press">{running && cur ? <span class="spin" /> : <Ic i={I.chevron} />}<span>{label}</span></summary>
      {showThinking && thinking.map((b) => <p class="step"><Ic i={I.brain} /><span class="obj selectable">{(b as any).text.slice(-400)}</span></p>)}
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

// ------------------------------------------------------------------ horloge et réflexion
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(".", ",")} s`;
/** Temps écoulé depuis `from`, mis à jour en direct tant que `to` n'est pas connu. */
export function Elapsed({ from, to }: { from?: number; to?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!from || to) return;
    const id = setInterval(() => tick((x) => x + 1), 100);
    return () => clearInterval(id);
  }, [from, to]);
  if (!from) return null;
  return <span class="elapsed">{secs((to ?? Date.now()) - from)}</span>;
}

function Thinking({ m, running }: { m: Msg; running: boolean }) {
  const text = m.blocks.filter((b) => b.k === "thinking").map((b) => (b as any).text).join("");
  if (!text.trim()) return null;
  const live = running && !m.thinkEnd;
  return (
    <details class="thinking" open={live}>
      <summary class="press">
        {live ? <span class="shimmer">Réfléchit…</span> : <span>A réfléchi</span>}
        <Elapsed from={m.thinkStart} to={m.thinkEnd} />
        <Ic i={I.chevron} />
      </summary>
      <div class="think-text selectable">{live ? text.slice(-1600) : text}</div>
    </details>
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
/** Le bloc HTML d'une réponse en mode canevas est remplacé, dans le fil, par une carte qui ouvre le canevas. */
function splitCanvas(text: string): { before: string; after: string; has: boolean } {
  const i = text.indexOf("```html");
  if (i < 0) return { before: text, after: "", has: false };
  const j = text.indexOf("```", i + 7);
  return { before: text.slice(0, i), after: j < 0 ? "" : text.slice(j + 3), has: true };
}

export function MessageView({ m, busy, onCanvas }: { m: Msg; busy: boolean; onCanvas?: () => void }) {
  if (m.role === "user") return <div class="msg user"><div class="bubble">{m.text}</div></div>;
  const running = !m.done && busy;
  const texts = m.blocks.filter((b) => b.k === "text") as Extract<Block, { k: "text" }>[];
  const notices = m.blocks.filter((b) => b.k === "notice") as Extract<Block, { k: "notice" }>[];
  const shown = m.cg ? m.text : texts.map((b) => b.text).join("") || m.text;
  const cv = m.canvas ? splitCanvas(shown) : null;
  const md = (t: string) => (t.trim() ? <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(t) }} /> : null);
  return (
    <div class="msg bot">
      <div class="body">
        {!m.cg && <Thinking m={m} running={running} />}
        {!m.cg && <Steps blocks={m.blocks} running={running} showThinking={false} />}
        {!shown && running && !m.thinkStart && (
          <div class="generating" aria-live="polite"><span class="pulse-dot" /><span class="shimmer">{m.cg ? "Les agents travaillent" : "Génère la réponse"}</span><Elapsed from={m.started} /></div>
        )}
        {cv ? <>{md(cv.before)}{cv.has && <button class="canvas-card press" onClick={onCanvas}><Ic i={I.pencil} /><span><b>Canevas</b><span class="dim">{running ? "S'écrit en direct…" : "Ouvrir à côté pour voir et retoucher"}</span></span>{running && <span class="spin" />}</button>}{md(cv.after)}</> : md(shown)}
        {notices.filter((n) => n.level === "error").map((n) => <p class="notice error"><Ic i={I.alert} />{n.text}</p>)}
        {running && shown && <div class="gen-foot"><span class="pulse-dot" /><Elapsed from={m.started} /></div>}
        {m.done && (
          <div class="msg-foot">
            <span>{m.interrupted ? "Interrompu · " : ""}{m.seconds ? secs(m.seconds * 1000) : ""}{m.tokens ? ` · ${fmtTok(m.tokens)} tokens` : ""}</span>
            <button class="mini press" title="Copier la réponse" onClick={() => navigator.clipboard?.writeText(msgText(m)).catch(() => {})}><Ic i={I.copy} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Type de média qu'une demande attend, d'après ses mots (pour éviter de demander de la musique à un modèle d'images). */
export function wantedKinds(text: string): Set<"image" | "video" | "audio"> {
  const t = text.toLowerCase();
  const out = new Set<"image" | "video" | "audio">();
  if (/\b(musique|chanson|audio|beat|boucle musicale|mélodie|melodie|bruitage|voix off|podcast|phonk|rap|lo-?fi)\b|\b(un|des|du|le) sons?\b/.test(t)) out.add("audio");
  if (/\b(vidéo|video|clip|film|animation|plan de drone|séquence|sequence)\b/.test(t)) out.add("video");
  if (/\b(image|photo|affiche|dessin|illustration|logo|portrait|tableau|poster|wallpaper|fond d'écran)\b/.test(t)) out.add("image");
  return out;
}
/** Le type attendu quand la demande n'en évoque qu'un ; null si elle en mélange plusieurs (« affiche d'un festival de musique »). */
export function wantedMedia(text: string): "image" | "video" | "audio" | null {
  const k = wantedKinds(text);
  return k.size === 1 ? [...k][0] : null;
}
export const KIND_LABEL: Record<string, string> = { image: "image", video: "vidéo", audio: "son" };

/** Le modèle de médias le plus adapté à une demande : un vrai générateur de musique pour de la musique, une voix pour une voix. */
export function bestMediaModel(media: MediaModel[], text: string, kind: "image" | "video" | "audio"): MediaModel | undefined {
  const pure = media.filter((m) => (m.category ? m.category === kind : !m.output.includes("text")) && m.output.includes(kind));
  const t = text.toLowerCase();
  const prefer = kind === "audio"
    ? /\b(voix|parle|lis|lecture|narration|narrateur|tts)\b/.test(t) ? /tts|orpheus|elevenlabs-v|voice/i : /lyria|stable-audio|music|suno|\budio\b/i
    : kind === "video" ? /veo|kling|seedance|runway|sora/i : /nano-banana|gpt-image|flux|imagen|seedream/i;
  return pure.find((m) => prefer.test(m.id)) ?? pure[0];
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
        const searching = !info && !!st.detecting;
        const z = t.zones[id];
        const stc = installed ? STATUS(z.status) : "idle";
        const model = st.cg.agents[id]?.model;
        const subs = t.subs.filter((s) => s.agent === id);
        return (
          <div class={`agent ${stc} ${open === id ? "on" : ""}`}>
            <button class="av press" onClick={() => onOpen(id)} title={`Voir ce que fait ${CG_LABEL[id]}`}><Ic i={I.robot} /></button>
            <button class="nm" onClick={() => onOpen(id)} style={{ textAlign: "left" }}>{CG_LABEL[id]}{model && <span class="model">{model}</span>}{st.cg.lead === id && <span class="tag">coordinateur</span>}</button>
            <span class="st"><i class={`dot ${searching ? "busy" : stc}`} />{searching ? "Recherche…" : STATUS_LABEL(z.status, installed)}</span>
            <span class="act">{searching ? "Eclipse cherche les agents installés" : installed ? activityOf(t, id) : "Installe-le pour qu'il participe"}</span>
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
// options que le modèle actif annonce dans son catalogue
const WEB_PARAMS = ["web_search", "tool_web_search", "enable_web_search", "web_search_linkup"];
export function capabilities(st: EngineState) {
  const ps = st.modelParams ?? [];
  const bool = (n: string) => ps.find((x) => x.name === n && x.kind === "boolean")?.name;
  const textModel = !st.modelOutput || st.modelOutput.includes("text");
  return {
    web: WEB_PARAMS.map(bool).find(Boolean),
    think: bool("enable_thinking"),
    showThink: bool("thinking_display") ?? bool("show_reasoning"),
    deep: /deep-research|researcher/i.test(st.current?.model ?? ""),
    canvas: st.current?.kind === "api" && textModel,
  };
}
const LEVELS: [string, string][] = [["", "Auto"], ["rapide", "Rapide"], ["normal", "Normal"], ["profond", "Approfondi"]];

function OptionsMenu(p: { st: EngineState; canvasOn: boolean; setCanvasOn: (b: boolean) => void; onOption: (name: string, v: boolean) => void; onDeep: () => void; onClose: () => void }) {
  const c = capabilities(p.st);
  const on = (n?: string) => !!n && p.st.modelOptions?.[n] === true;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) p.onClose(); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    setTimeout(() => addEventListener("pointerdown", out), 0);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", out); removeEventListener("keydown", esc); };
  }, []);
  const Item = ({ icon, label, hint, active, onClick, disabled }: { icon: string; label: string; hint: string; active?: boolean; onClick: () => void; disabled?: boolean }) => (
    <button class="menu-item press" onClick={onClick} disabled={disabled} role="menuitemcheckbox" aria-checked={!!active}>
      <Ic i={icon} /><span class="grow"><span>{label}</span><span class="dim small">{hint}</span></span>{active && <Ic i={I.check} />}
    </button>
  );
  const none = !c.web && !c.think && !c.canvas && !p.st.deepResearch.length;
  return (
    <div class="menu" ref={ref} role="menu">
      {c.web && <Item icon={I.search} label="Recherche sur le web" hint="Le modèle consulte des sources récentes" active={on(c.web)} onClick={() => p.onOption(c.web!, !on(c.web))} />}
      {c.think && <Item icon={I.brain} label="Réflexion" hint="Il raisonne avant de répondre" active={on(c.think)} onClick={() => p.onOption(c.think!, !on(c.think))} />}
      {c.showThink && <Item icon={I.brain} label="Montrer la réflexion" hint="Afficher son raisonnement pendant qu'il pense" active={on(c.showThink)} onClick={() => p.onOption(c.showThink!, !on(c.showThink))} />}
      {p.st.deepResearch.length > 0 && <Item icon={I.search} label="Recherche approfondie" hint={c.deep ? "Modèle de recherche approfondie actif" : `Passe sur ${p.st.deepResearch[0].id}`} active={c.deep} onClick={p.onDeep} disabled={c.deep} />}
      {c.canvas && <Item icon={I.pencil} label="Canevas" hint="Un design ou un document à côté, modifiable en direct" active={p.canvasOn} onClick={() => p.setCanvasOn(!p.canvasOn)} />}
      {none && <p class="menu-empty dim small">Ce modèle n'annonce pas d'option.</p>}
    </div>
  );
}

export function Composer(p: {
  st: EngineState; space: Space; busy: boolean; cgOn: boolean; setCgOn: (b: boolean) => void; onSend: (t: string) => void; onStop: () => void;
  canvasOn: boolean; setCanvasOn: (b: boolean) => void; onOption: (name: string, v: boolean) => void; onDeep: () => void;
  onModels: () => void; onEffort: (v: string | null) => void; media: MediaModel[]; mediaModel: MediaModel | null; setMediaModel: (m: MediaModel | null) => void;
  voice: { state: string; level: number }; onDictate: () => void; onStopDictate: () => void; draft: string; setDraft: (s: string) => void; history: string[];
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [hi, setHi] = useState(-1);
  const [menu, setMenu] = useState(false);
  const caps = capabilities(p.st);
  const optOn = (n?: string) => !!n && p.st.modelOptions?.[n] === true;
  const apiModel = p.space !== "medias" && !(p.space === "work" && p.cgOn);
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
  // générateurs rangés par type (même classement que le choix du modèle), puis les polyvalents qui créent aussi des médias
  const cat = (m: MediaModel) => m.category ?? (m.output.includes("text") ? "multi" : m.output.includes("video") ? "video" : m.output.includes("image") ? "image" : "audio");
  const groups: [string, MediaModel[]][] = ([["image", "Images"], ["video", "Vidéo"], ["audio", "Son"], ["multi", "Multifonctions"]] as const)
    .map(([k, l]) => [l, p.media.filter((m) => cat(m) === k)] as [string, MediaModel[]])
    .filter((g) => g[1].length);
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
                {ms.map((m) => <option value={`${m.provider}/${m.id}`}>{m.id} · {m.output.filter((o) => o !== "text").map((o) => KIND_LABEL[o] ?? o).join(" + ")}</option>)}
              </optgroup>
            ))}
          </select>
        ) : !(p.space === "work" && p.cgOn) ? (
          <button class="chip-btn press" onClick={p.onModels} title="Changer de modèle (Ctrl+K)"><span class="lbl">{p.st.label}</span><Ic i={I.chevron} /></button>
        ) : (
          <span class="chip-btn" style={{ cursor: "default" }}><span class="lbl">Claude Code et Codex</span></span>
        )}
        {apiModel && p.st.efforts.length > 0 && (
          <div class="mini-seg" role="radiogroup" aria-label="Effort de réflexion" title="Effort de réflexion">
            {LEVELS.map(([v, l]) => <button role="radio" aria-checked={(p.st.effort ?? "") === v} class={`press ${(p.st.effort ?? "") === v ? "on" : ""}`} onClick={() => p.onEffort(v || null)}>{l}</button>)}
          </div>
        )}
        {apiModel && (
          <div class="menu-wrap">
            <button class={`icon-btn press ${menu ? "on" : ""}`} onClick={() => setMenu(!menu)} title="Options du modèle : recherche web, réflexion, canevas…" aria-haspopup="menu" aria-expanded={menu}><Ic i={I.plus} /></button>
            {menu && <OptionsMenu st={p.st} canvasOn={p.canvasOn} setCanvasOn={p.setCanvasOn} onOption={p.onOption} onDeep={() => { setMenu(false); p.onDeep(); }} onClose={() => setMenu(false)} />}
          </div>
        )}
        {apiModel && optOn(caps.web) && <button class="opt-pill press" onClick={() => p.onOption(caps.web!, false)} title="Retirer"><Ic i={I.search} />Web<Ic i={I.close} /></button>}
        {apiModel && optOn(caps.think) && <button class="opt-pill press" onClick={() => p.onOption(caps.think!, false)} title="Retirer"><Ic i={I.brain} />Réflexion<Ic i={I.close} /></button>}
        {apiModel && caps.deep && <span class="opt-pill"><Ic i={I.search} />Recherche approfondie</span>}
        {apiModel && p.canvasOn && caps.canvas && <button class="opt-pill press" onClick={() => p.setCanvasOn(false)} title="Retirer"><Ic i={I.pencil} />Canevas<Ic i={I.close} /></button>}
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

// ------------------------------------------------------------------ canevas : aperçu en direct et code modifiable
export function CanvasPanel(p: { html: string; streaming: boolean; edited: boolean; onEdit: (html: string) => void; onReset: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<"apercu" | "code">("apercu");
  const [shown, setShown] = useState(p.html);
  // pendant l'écriture, l'aperçu suit le texte sans clignoter (au plus 4 rafraîchissements par seconde)
  useEffect(() => {
    if (!p.streaming) { setShown(p.html); return; }
    const id = setTimeout(() => setShown(p.html), 250);
    return () => clearTimeout(id);
  }, [p.html, p.streaming]);
  return (
    <aside class="canvas" aria-label="Canevas">
      <div class="canvas-head">
        <div class="segmented" style={{ width: "190px" }}>
          <button class={`press ${tab === "apercu" ? "on" : ""}`} onClick={() => setTab("apercu")}>Aperçu</button>
          <button class={`press ${tab === "code" ? "on" : ""}`} onClick={() => setTab("code")}>Code</button>
        </div>
        {p.streaming && <span class="dim small" style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}><span class="spin" />S'écrit en direct</span>}
        {p.edited && !p.streaming && <button class="chip-btn press" onClick={p.onReset} title="Revenir à la version du modèle">Retouché à la main · annuler</button>}
        <span class="grow" />
        <button class="icon-btn press" title="Copier le HTML" onClick={() => navigator.clipboard?.writeText(p.html).catch(() => {})}><Ic i={I.copy} /></button>
        <button class="icon-btn press" title="Fermer le canevas" onClick={p.onClose}><Ic i={I.close} /></button>
      </div>
      {tab === "apercu"
        // bac à sable sans scripts ni accès à l'application : le design s'affiche, il ne peut rien faire d'autre
        ? <iframe class="canvas-frame" title="Aperçu du canevas" sandbox="" srcdoc={shown || "<p style='font:14px system-ui;color:#888;padding:24px'>Le canevas s'affichera ici.</p>"} />
        : <textarea class="canvas-code mono" spellcheck={false} value={p.html} onInput={(e) => p.onEdit((e.target as HTMLTextAreaElement).value)} aria-label="Code HTML du canevas" />}
      <p class="canvas-hint dim small">Demande une modification dans la discussion, ou retouche le code : le modèle repart de ta version.</p>
    </aside>
  );
}
