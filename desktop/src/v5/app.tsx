/**
 * Eclipse Desktop 5 : un mélange de Claude (barre latérale calme, fil centré, grande zone de saisie) et de Hermes Agent
 * (teintes chaudes sombres, accent or pour l'activité des agents, détails en police à chasse fixe).
 * Trois espaces : Conversation (graphiques, micro, appel), Work (projet, agent ou /cg avec onglets), Médias.
 * Même moteur, mêmes données que le terminal (mémoire, sessions, consommation, clés, MCP, projets).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { ApiError, connect, events, get, isDesktop, post, restartEngine, type EngineState, type MediaModel, type SessionRow, type Space } from "./api";
import { I } from "./icons";
import { safeUrl } from "./markdown";
import { Lightbox, ModelPicker, PermModal, ProjectChooser, Settings, SubModal, UsageView } from "./modals";
import { CgPanel, Composer, MessageView, Rail, Sidebar, StatusBar, SubDots, Welcome } from "./parts";
import { emptyThread, fromHistory, reduce, settle, type Sub, type ThreadState } from "./thread";

type Action = { t: "ev"; e: any; cg: boolean } | { t: "set"; s: ThreadState } | { t: "settle" };
const threadReducer = (s: ThreadState, a: Action) => (a.t === "set" ? a.s : a.t === "settle" ? settle(s) : reduce(s, a.e, { cg: a.cg }));

type Overlay = { kind: "models" } | { kind: "settings"; tab?: string } | { kind: "usage" } | { kind: "project"; propose?: string; text?: string } | { kind: "sub"; sub: Sub } | { kind: "image"; url: string };
interface Toast { id: number; text: string; level: string }

const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem(`eclipse.${k}`) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`eclipse.${k}`, v); } catch { /* stockage indisponible */ } },
};

function applyTheme(t: string) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

export function App() {
  const [phase, setPhase] = useState<"connect" | "ready" | "error">("connect");
  const [fatal, setFatal] = useState("");
  const [st, setSt] = useState<EngineState | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [space, setSpaceRaw] = useState<Space>(() => store.get("space", "conversation") as Space);
  const [thread, dispatch] = useReducer(threadReducer, undefined, emptyThread);
  const [cgOn, setCgOnRaw] = useState(() => store.get("cg", "0") === "1");
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [perm, setPerm] = useState<{ id: number; req: any } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [voice, setVoice] = useState({ state: "", call: false, level: 0, heard: "" });
  const [railOpen, setRailOpen] = useState(() => store.get("rail", "1") === "1");
  const [sideCollapsed, setSideCollapsed] = useState(() => store.get("side", "0") === "1");
  const [tab, setTab] = useState("ensemble");
  const [media, setMedia] = useState<MediaModel[]>([]);
  const [mediaModel, setMediaModelRaw] = useState<MediaModel | null>(null);
  const [connected, setConnected] = useState(false);
  const [theme, setThemeRaw] = useState(() => store.get("theme", "system"));
  const [draft, setDraft] = useState("");
  const [today, setToday] = useState(0);
  const cgPending = useRef(false);
  const busyRef = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const toast = (text: string, level = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === "error" ? 9000 : 4500);
  };
  const setTheme = (t: string) => { setThemeRaw(t); store.set("theme", t); applyTheme(t); };
  const setCgOn = (b: boolean) => { setCgOnRaw(b); store.set("cg", b ? "1" : "0"); };
  const setMediaModel = (m: MediaModel | null) => { setMediaModelRaw(m); store.set("media", m ? `${m.provider}/${m.id}` : ""); };

  // ---------------------------------------------------------------- moteur
  const refresh = useRef<ReturnType<typeof setTimeout>>();
  const reload = () => {
    clearTimeout(refresh.current);
    refresh.current = setTimeout(() => {
      get<EngineState>("/api/state").then(setSt).catch(() => {});
      get<SessionRow[]>("/api/sessions").then(setSessions).catch(() => {});
    }, 120);
  };
  const loadUsage = () => get("/api/usage").then((u: any) => setToday(u.periods?.[0]?.tokens ?? 0)).catch(() => {});
  // les catalogues se chargent en arrière-plan dans le moteur : la liste des modèles de médias est relue au besoin
  const mediaCount = useRef(0);
  const loadMedia = () => get<MediaModel[]>("/api/media/models").then((m) => {
    mediaCount.current = m.length;
    setMedia(m);
    const saved = store.get("media", "");
    setMediaModelRaw((cur) => cur ?? m.find((x) => `${x.provider}/${x.id}` === saved) ?? null);
  }).catch(() => {});

  useEffect(() => {
    applyTheme(theme);
    let stop = () => {};
    (async () => {
      try {
        await connect();
        const [s, ss] = await Promise.all([get<EngineState>("/api/state"), get<SessionRow[]>("/api/sessions")]);
        setSt(s);
        setSessions(ss);
        setPhase("ready");
        loadUsage();
        loadMedia();
        let wasDown = false;
        stop = events(onEvent, (up) => {
          setConnected(up);
          if (!up) { wasDown = true; return; }
          if (!wasDown) return;
          wasDown = false;
          // des événements ont pu se perdre pendant la coupure (dont la fin du tour) : on resynchronise
          get<EngineState>("/api/state").then((s2) => { setSt(s2); if (!s2.busy) dispatch({ t: "settle" }); }).catch(() => {});
          get<SessionRow[]>("/api/sessions").then(setSessions).catch(() => {});
        });
      } catch (e: any) {
        setFatal(e.message ?? String(e));
        setPhase("error");
      }
    })();
    return () => stop();
  }, []);

  function onEvent(e: any) {
    switch (e.type) {
      case "state":
        if (!mediaCount.current) loadMedia();
        return reload();
      case "perm": return setPerm({ id: e.id, req: e.req });
      case "voice": return setVoice((v) => ({ ...v, state: e.state ?? "", call: e.call ?? v.call }));
      case "voice-level": return setVoice((v) => ({ ...v, level: e.level ?? 0 }));
      case "voice-text": return setVoice((v) => ({ ...v, heard: e.text ?? "" }));
      case "notice":
        // pendant une réponse, l'avis s'inscrit dans le fil ; sinon (ou si c'est une erreur) il s'affiche en bulle
        if (e.level === "error" || !busyRef.current) toast(e.text, e.level);
        dispatch({ t: "ev", e, cg: cgPending.current });
        return;
      case "done":
        dispatch({ t: "ev", e, cg: cgPending.current });
        loadUsage();
        reload();
        return;
      default:
        dispatch({ t: "ev", e, cg: cgPending.current });
    }
  }

  // défilement : reste collé en bas tant que l'utilisateur n'est pas remonté
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // infobulles des graphiques, boutons « Copier », images en grand (délégation : le HTML vient du rendu Markdown)
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    document.body.appendChild(tip);
    const move = (ev: MouseEvent) => {
      const g = (ev.target as Element | null)?.closest?.("[data-tip]");
      if (!g) { tip.style.opacity = "0"; return; }
      tip.textContent = g.getAttribute("data-tip");
      tip.style.opacity = "1";
      tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, ev.clientX + 14) + "px";
      tip.style.top = ev.clientY - 34 + "px";
    };
    const click = (ev: MouseEvent) => {
      const t = ev.target as Element;
      const copy = t.closest?.("[data-copy]");
      if (copy) {
        const code = copy.closest(".code")?.querySelector("code")?.textContent ?? "";
        navigator.clipboard?.writeText(code).then(() => { copy.textContent = "Copié"; setTimeout(() => (copy.textContent = "Copier"), 1400); }).catch(() => {});
        return;
      }
      const img = t.closest?.("[data-media]");
      if (img) {
        ev.preventDefault();
        const url = img.getAttribute("data-media") ?? "";
        if (safeUrl(url)) setOverlay({ kind: "image", url }); // adresse revérifiée : du HTML brut peut fournir son propre data-media
      }
    };
    addEventListener("mousemove", move);
    addEventListener("click", click);
    return () => { removeEventListener("mousemove", move); removeEventListener("click", click); tip.remove(); };
  }, []);

  // raccourcis : Échap arrête, Ctrl+N nouvelle discussion, Ctrl+K modèles, Ctrl+B barre latérale
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && st?.busy && !overlay && !perm) { post("/api/interrupt").catch(() => {}); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "n") { e.preventDefault(); newChat(); }
      else if (e.key === "k") { e.preventDefault(); setOverlay({ kind: "models" }); }
      else if (e.key === "b") { e.preventDefault(); toggleSide(); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });

  // ---------------------------------------------------------------- actions
  const newChat = async () => {
    if (st?.busy) return toast("Une réponse est en cours : attendez la fin ou arrêtez-la (Échap).", "warn");
    try { await post("/api/new"); } catch (e: any) { return toast(e.message, "error"); }
    dispatch({ t: "set", s: emptyThread() });
    setTab("ensemble");
    stick.current = true;
  };
  const setSpace = (s: Space) => {
    if (s === space) return;
    if (st?.busy) return toast("Une réponse est en cours : attendez la fin ou arrêtez-la (Échap).", "warn");
    setSpaceRaw(s);
    store.set("space", s);
    if (s === "medias") loadMedia();
    if (thread.msgs.length) newChat();
  };
  const openSession = async (row: SessionRow) => {
    if (st?.busy) return toast("Une réponse est en cours : attendez la fin ou arrêtez-la (Échap).", "warn");
    try {
      const r = await post<{ messages: { role: string; text: string }[]; state: EngineState }>("/api/sessions/open", { id: row.id });
      setSpaceRaw(row.space);
      store.set("space", row.space);
      if (row.space === "work") setCgOn(row.cg);
      setSt(r.state);
      dispatch({ t: "set", s: fromHistory(r.messages, row.space) });
      stick.current = true;
    } catch (e: any) { toast(e.message, "error"); }
  };
  const send = async (text: string, force?: Space) => {
    const sp = force ?? space;
    if (!st || st.busy || !text.trim()) return;
    if (sp === "medias" && !mediaModel) return toast("Choisissez d'abord un modèle d'image, de vidéo ou de son.", "warn");
    cgPending.current = sp === "work" && cgOn;
    stick.current = true;
    try {
      await post("/api/send", { text, space: sp, cg: cgPending.current, mediaModel: sp === "medias" ? mediaModel : undefined });
      setDraft("");
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 412) setOverlay({ kind: "project", propose: e.body?.propose, text });
      else toast(e.message, "error");
    }
  };
  const dictate = async () => {
    if (voice.state === "écoute") return;
    try {
      const r = await post<{ ok: boolean; text?: string; reason?: string }>("/api/voice/dictate");
      if (r.ok && r.text) setDraft((d) => (d ? d + " " : "") + r.text);
      else toast(r.reason ?? "rien entendu", "warn");
    } catch (e: any) { toast(e.message, "error"); }
  };
  const call = async () => {
    try {
      if (voice.call) await post("/api/voice/call", { on: false });
      else {
        const r = await post<{ ok: boolean; reason?: string }>("/api/voice/call", { on: true, space, cg: space === "work" && cgOn });
        if (!r.ok) toast(`Appel impossible : ${r.reason}`, "error");
        else cgPending.current = space === "work" && cgOn;
      }
    } catch (e: any) { toast(e.message, "error"); }
  };
  const toggleSide = () => setSideCollapsed((c) => { store.set("side", c ? "0" : "1"); return !c; });
  const toggleRail = () => setRailOpen((r) => { store.set("rail", r ? "0" : "1"); return !r; });

  const history = useMemo(() => thread.msgs.filter((m) => m.role === "user").map((m) => m.text).reverse(), [thread.msgs]);
  const busy = !!st?.busy;
  busyRef.current = busy;

  // ---------------------------------------------------------------- écrans
  if (phase === "connect") return <div class="boot"><span class="logo pulse">{I.eclipse}</span><p>Démarrage du moteur Eclipse…</p></div>;
  if (phase === "error" || !st)
    return (
      <div class="boot">
        <span class="logo">{I.eclipse}</span>
        <h2>Le moteur ne répond pas</h2>
        <p class="bad">{fatal}</p>
        {isDesktop && <button class="btn primary" onClick={() => restartEngine().then(() => location.reload()).catch((e) => setFatal(e.message))}>{I.refresh} Relancer le moteur</button>}
      </div>
    );

  const showCg = space === "work" && (cgOn || thread.cgTurn) && thread.msgs.some((m) => m.cg);
  const empty = !thread.msgs.length;
  return (
    <div class={`app ${sideCollapsed ? "side-min" : ""} ${railOpen ? "rail-on" : ""} space-${space}`}>
      <Sidebar st={st} sessions={sessions} space={space} onSpace={setSpace} onNew={newChat} onOpen={openSession} collapsed={sideCollapsed} onCollapse={toggleSide}
        onUsage={() => setOverlay({ kind: "usage" })} onSettings={() => setOverlay({ kind: "settings" })} onProjects={() => setOverlay({ kind: "project" })} />
      <main class="main">
        <header class="top">
          <div class="title">{st.title || (space === "work" ? "Nouveau travail" : space === "medias" ? "Nouvelle création" : "Nouvelle discussion")}</div>
          {space === "work" && !st.needsProject && <button class="chip proj" onClick={() => setOverlay({ kind: "project" })} title={st.cwd}>{I.folder} {st.cwdShort.split("/").pop()}</button>}
          <div class="top-actions">
            <button class={`icon-btn ${railOpen ? "on" : ""}`} onClick={toggleRail} title="Aperçu : graphiques, médias, tâches">{I.rail}</button>
          </div>
        </header>
        {voice.call && (
          <div class="call-banner">
            <span class="wave" style={{ "--l": String(Math.min(1, voice.level * 6)) } as any}>{I.wave}</span>
            <b>Appel en cours</b><span class="dim">{voice.state || "…"}{voice.heard ? ` · « ${voice.heard} »` : ""}</span>
            <button class="btn danger small" onClick={call}>{I.hangup} Raccrocher</button>
          </div>
        )}
        {showCg && <CgPanel t={thread} tab={tab} setTab={setTab} />}
        <div class="scroller" ref={scroller} onScroll={onScroll}>
          <div class="thread">
            {empty ? <Welcome space={space} st={st} onPick={(t) => (space === "work" && st.needsProject ? setOverlay({ kind: "project", text: t }) : setDraft(t))} />
              : thread.msgs.map((m) => <MessageView m={m} busy={busy} />)}
          </div>
        </div>
        <div class="dock">
          <SubDots subs={showCg ? [] : thread.subs} onOpen={(s) => setOverlay({ kind: "sub", sub: s })} />
          {space === "work" && st.needsProject && <button class="need-project" onClick={() => setOverlay({ kind: "project" })}>{I.folder} Choisissez ou créez un projet pour travailler</button>}
          <Composer st={st} space={space} busy={busy} cgOn={cgOn} setCgOn={setCgOn} onSend={(t) => send(t)} onStop={() => post("/api/interrupt").catch(() => {})}
            onModels={() => setOverlay({ kind: "models" })} onEffort={(v) => post("/api/effort", { value: v }).catch((e) => toast(e.message, "error"))}
            media={media} mediaModel={mediaModel} setMediaModel={setMediaModel} voice={voice} onDictate={dictate} onCall={call} draft={draft} setDraft={setDraft} history={history} />
          <StatusBar st={st} today={today} connected={connected} />
        </div>
      </main>
      {railOpen && <Rail t={thread} st={st} space={space} onClose={toggleRail} onMedia={(url) => setOverlay({ kind: "image", url })} onSub={(s) => (showCg ? setTab(`sub:${s.id}`) : setOverlay({ kind: "sub", sub: s }))} />}

      {overlay?.kind === "models" && <ModelPicker onClose={() => setOverlay(null)} onKeys={() => setOverlay({ kind: "settings", tab: "keys" })} toast={toast} />}
      {overlay?.kind === "settings" && <Settings st={st} start={overlay.tab} onClose={() => setOverlay(null)} toast={toast} theme={theme} setTheme={setTheme} />}
      {overlay?.kind === "usage" && <UsageView onClose={() => setOverlay(null)} />}
      {overlay?.kind === "project" && (
        <ProjectChooser st={st} propose={overlay.propose} toast={toast} onClose={() => setOverlay(null)}
          onDone={() => { const t = overlay.text; setOverlay(null); dispatch({ t: "set", s: emptyThread() }); reload(); if (t) setTimeout(() => send(t, "work"), 300); }} />
      )}
      {overlay?.kind === "sub" && <SubModal sub={thread.subs.find((s) => s.id === overlay.sub.id) ?? overlay.sub} onClose={() => setOverlay(null)} />}
      {overlay?.kind === "image" && <Lightbox url={overlay.url} onClose={() => setOverlay(null)} />}
      {perm && <PermModal perm={perm} onDecide={(d) => { post("/api/perm", { id: perm.id, decision: d }).catch(() => {}); setPerm(null); }} />}
      <div class="toasts" aria-live="polite">{toasts.map((t) => <div class={`toast ${t.level}`}>{t.text}</div>)}</div>
    </div>
  );
}
