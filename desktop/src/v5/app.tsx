/**
 * Eclipse Desktop 5 : un mélange de Claude (barre latérale calme, fil centré, grande zone de saisie) et de Hermes Agent
 * (teintes chaudes sombres, accent or pour l'activité des agents, détails en police à chasse fixe).
 * Trois espaces : Conversation (graphiques, micro, appel), Work (projet, agent ou /cg avec onglets), Médias.
 * Même moteur, mêmes données que le terminal (mémoire, sessions, consommation, clés, MCP, projets).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { ApiError, connect, copyText, events, get, isDesktop, post, restartEngine, type EngineState, type MediaModel, type SessionRow, type Space } from "./api";
import { I } from "./icons";
import { safeUrl } from "./markdown";
import { Lightbox, ModelPicker, PermModal, ProjectChooser, Settings, UsageView } from "./modals";
import { AgentSheet, AgentsStrip, bestMediaModel, CanvasPanel, Composer, KIND_LABEL, MessageView, Rail, railHasContent, Sidebar, StatusBar, wantedMedia, Welcome } from "./parts";
import { emptyThread, fromHistory, lastCanvas, reduce, settle, type ThreadState } from "./thread";

type Action = { t: "ev"; e: any; cg: boolean; canvas?: boolean; images?: string[] } | { t: "set"; s: ThreadState } | { t: "settle" };
const threadReducer = (s: ThreadState, a: Action) => (a.t === "set" ? a.s : a.t === "settle" ? settle(s) : reduce(s, a.e, { cg: a.cg, canvas: a.canvas, images: a.images }));

type Overlay = { kind: "models" } | { kind: "settings"; tab?: string } | { kind: "usage" } | { kind: "project"; propose?: string; text?: string } | { kind: "image"; url: string };
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
  const [voice, setVoice] = useState({ state: "", level: 0 });
  const [railOpen, setRailOpen] = useState(() => store.get("rail", "0") === "1");
  const [sheet, setSheet] = useState<string | null>(null); // agent ou sous-agent affiché dans le panneau de droite
  const [scrolled, setScrolled] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(() => store.get("side", "0") === "1");
  const [media, setMedia] = useState<MediaModel[]>([]);
  const [mediaModel, setMediaModelRaw] = useState<MediaModel | null>(null);
  const [connected, setConnected] = useState(false);
  const [theme, setThemeRaw] = useState(() => store.get("theme", "system"));
  const [draft, setDraft] = useState("");
  const [today, setToday] = useState(0);
  const cgPending = useRef(false);
  const imagesPending = useRef<string[]>([]);
  const [images, setImages] = useState<string[]>([]); // images collées dans la saisie, pas encore envoyées
  const canvasPending = useRef(false);
  const [canvasOn, setCanvasOnRaw] = useState(() => store.get("canvas", "0") === "1");
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasEdit, setCanvasEdit] = useState<string | null>(null); // version retouchée à la main
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
  const setCanvasOn = (b: boolean) => { setCanvasOnRaw(b); store.set("canvas", b ? "1" : "0"); if (!b) setCanvasOpen(false); };
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
      case "voice": return setVoice((v) => ({ ...v, state: e.state ?? "" }));
      case "voice-level": return setVoice((v) => ({ ...v, level: e.level ?? 0 }));
      case "notice":
        // pendant une réponse, l'avis s'inscrit dans le fil ; sinon (ou si c'est une erreur) il s'affiche en bulle
        if (e.level === "error" || e.level === "warn") toast(e.text, e.level); // les simples informations restent discrètes
        dispatch({ t: "ev", e, cg: cgPending.current, canvas: canvasPending.current, images: e.type === "turn" ? imagesPending.current : undefined });
        return;
      case "done":
        dispatch({ t: "ev", e, cg: cgPending.current, canvas: canvasPending.current, images: e.type === "turn" ? imagesPending.current : undefined });
        loadUsage();
        reload();
        return;
      default:
        dispatch({ t: "ev", e, cg: cgPending.current, canvas: canvasPending.current, images: e.type === "turn" ? imagesPending.current : undefined });
    }
  }

  // défilement : reste collé en bas tant que l'utilisateur n'est pas remonté
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setScrolled(el.scrollTop > 4);
    }
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
        copyText(code).then((ok) => { if (ok) { copy.textContent = "Copié"; setTimeout(() => (copy.textContent = "Copier"), 1400); } });
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
      if (e.key === "Escape" && sheet && !overlay && !perm) { setSheet(null); return; }
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
    setSheet(null);
    setCanvasEdit(null);
    setCanvasOpen(false);
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
    if (!st || st.busy || (!text.trim() && !images.length)) return;
    if (sp === "medias" && !mediaModel) return toast("Choisis d'abord un modèle d'image, de vidéo ou de son.", "warn");
    if (sp === "medias" && mediaModel) {
      const want = wantedMedia(text);
      if (want && !mediaModel.output.includes(want))
        return toast(`${mediaModel.id} crée ${mediaModel.output.filter((o) => o !== "text").map((o) => "des " + (o === "audio" ? "sons" : o === "video" ? "vidéos" : "images")).join(" et ")}. Pour ${want === "audio" ? "un son" : want === "video" ? "une vidéo" : "une image"}, choisis un modèle du groupe ${KIND_LABEL[want] === "son" ? "Son" : KIND_LABEL[want] === "vidéo" ? "Vidéo" : "Images"}.`, "warn");
    }
    cgPending.current = sp === "work" && cgOn;
    canvasPending.current = canvasOn && sp !== "medias" && !cgPending.current && st.current?.kind === "api";
    stick.current = true;
    try {
      // canevas : le modèle repart de la version affichée (celle du modèle, ou celle retouchée à la main)
      const cur = canvasPending.current ? canvasEdit ?? lastCanvas(thread)?.html ?? "" : undefined;
      imagesPending.current = images;
      await post("/api/send", { text: text.trim() || "Regarde cette image.", space: sp, cg: cgPending.current, mediaModel: sp === "medias" ? mediaModel : undefined, canvas: cur,
        images: images.map((dataUrl, i) => ({ name: `image-${i + 1}`, dataUrl })) });
      setImages([]);
      if (canvasPending.current) { setCanvasEdit(null); setCanvasOpen(true); }
      setDraft("");
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 412) setOverlay({ kind: "project", propose: e.body?.propose, text });
      else toast(e.message, "error");
    }
  };
  // dictée : la voix devient du texte dans la saisie (transcription d'OpenAI), rien n'est lu à voix haute
  const dictate = async () => {
    if (voice.state) return;
    try {
      const r = await post<{ ok: boolean; text?: string; reason?: string }>("/api/voice/dictate");
      if (r.ok && r.text) setDraft((d) => (d ? d.trimEnd() + " " : "") + r.text);
      else if (r.reason && !/arrêt/i.test(r.reason)) toast(r.reason, "warn");
    } catch (e: any) { toast(e.message, "error"); }
  };
  const stopDictate = () => post("/api/voice/stop").catch(() => {});
  const setOption = (name: string, v: boolean) => post("/api/model-options", { values: { [name]: v ? true : null } }).then((s2: any) => setSt(s2)).catch((e) => toast(e.message, "error"));
  const goDeep = () => {
    const d = st?.deepResearch[0];
    if (!d) return;
    post("/api/choose", { kind: "api", provider: d.provider, model: d.id }).then(() => toast(`Recherche approfondie : ${d.id}. Change de modèle pour revenir.`)).catch((e) => toast(e.message, "error"));
  };
  const toggleSide = () => setSideCollapsed((c) => { store.set("side", c ? "0" : "1"); return !c; });
  const toggleRail = () => setRailOpen((r) => { store.set("rail", r ? "0" : "1"); return !r; });

  const history = useMemo(() => thread.msgs.filter((m) => m.role === "user").map((m) => m.text).reverse(), [thread.msgs]);
  const busy = !!st?.busy;
  busyRef.current = busy;

  // ---------------------------------------------------------------- écrans
  if (phase === "connect") return <div class="boot"><span class="ic logo breath">{I.eclipse}</span><p>Démarrage…</p></div>;
  if (phase === "error" || !st)
    return (
      <div class="boot">
        <span class="ic logo">{I.eclipse}</span>
        <h2>Le moteur ne répond pas</h2>
        <p>{fatal}</p>
        {isDesktop && <button class="btn primary press" onClick={() => restartEngine().then(() => location.reload()).catch((e) => setFatal(e.message))}>Relancer le moteur</button>}
      </div>
    );

  const cgView = space === "work" && cgOn;
  const canvas = lastCanvas(thread);
  const canvasHtml = canvasEdit ?? canvas?.html ?? "";
  const showCanvas = canvasOpen && (!!canvas || canvasEdit !== null);
  const empty = !thread.msgs.length;
  const railDot = !railOpen && railHasContent(thread);
  return (
    <div class={`app ${sideCollapsed ? "side-min" : ""} ${railOpen && !showCanvas ? "rail-on" : ""} ${showCanvas ? "canvas-on" : ""}`}>
      <Sidebar st={st} sessions={sessions} space={space} onSpace={setSpace} onNew={newChat} onOpen={openSession} onCollapse={toggleSide}
        onUsage={() => setOverlay({ kind: "usage" })} onSettings={() => setOverlay({ kind: "settings" })} onProjects={() => setOverlay({ kind: "project" })} />
      <main class="main">
        {busy && <div class="progress" role="progressbar" aria-label="Génération en cours" />}
        <header class={`top ${scrolled ? "scrolled" : ""}`}>
          {sideCollapsed && <button class="icon-btn press" onClick={toggleSide} title="Afficher la barre latérale (Ctrl+B)"><span class="ic">{I.menu}</span></button>}
          <div class="title">{(!empty && st.title) || (space === "work" ? "Nouveau travail" : space === "medias" ? "Nouvelle création" : "Nouvelle discussion")}</div>
          {space === "work" && !st.needsProject && <button class="pill press" onClick={() => setOverlay({ kind: "project" })} title={st.cwd}><span class="ic">{I.folder}</span>{st.cwdShort.split("/").pop()}</button>}
          <span class="spacer" />
          <button class={`icon-btn press ${railOpen ? "on" : ""}`} onClick={toggleRail} title="Aperçu : graphiques, images, tâches">
            <span class="ic">{I.rail}</span>{railDot && <span class="badge" style={{ position: "absolute", marginLeft: "18px", marginTop: "-14px" }} />}
          </button>
        </header>
        {cgView && <AgentsStrip st={st} t={thread} open={sheet} onOpen={(k) => setSheet((cur) => (cur === k ? null : k))} />}
        <div class="scroller" ref={scroller} onScroll={onScroll}>
          <div class="thread">
            {empty ? <Welcome space={space} st={st} onPick={(t) => {
              if (space === "work" && st.needsProject) return setOverlay({ kind: "project", text: t });
              if (space === "medias") {
                const want = wantedMedia(t);
                if (want) { // idée cliquée : le modèle le plus adapté (musique -> générateur de musique, pas une voix)
                  const m = bestMediaModel(media, t, want);
                  if (m && m.id !== mediaModel?.id) { setMediaModel(m); toast(`Modèle de ${KIND_LABEL[want]} choisi : ${m.id}`); }
                }
              }
              setDraft(t);
            }} />
              : thread.msgs.map((m) => <MessageView m={m} busy={busy} onCanvas={() => setCanvasOpen(true)} />)}
          </div>
        </div>
        <div class="dock">
          <div class="dock-inner">
            {space === "work" && st.needsProject && <button class="need-project press" onClick={() => setOverlay({ kind: "project" })}><span class="ic">{I.folder}</span>Choisis ou crée un projet pour travailler</button>}
            <Composer st={st} space={space} busy={busy} cgOn={cgOn} setCgOn={setCgOn} onSend={(t) => send(t)} onStop={() => post("/api/interrupt").catch(() => {})}
              canvasOn={canvasOn} setCanvasOn={setCanvasOn} onOption={setOption} onDeep={goDeep}
              onModels={() => setOverlay({ kind: "models" })} onEffort={(v) => post("/api/effort", { value: v }).catch((e) => toast(e.message, "error"))}
              media={media} mediaModel={mediaModel} setMediaModel={setMediaModel} voice={voice} onDictate={dictate} onStopDictate={stopDictate} draft={draft} setDraft={setDraft} history={history}
              images={images} setImages={setImages} onError={(m) => toast(m, "warn")} />
          </div>
        </div>
        <StatusBar st={st} today={today} connected={connected} />
        <AgentSheet t={thread} which={cgView || thread.subs.length ? sheet : null} onClose={() => setSheet(null)} />
      </main>
      {showCanvas
        ? <CanvasPanel html={canvasHtml} streaming={!!canvas?.streaming && canvasEdit === null} edited={canvasEdit !== null} onEdit={setCanvasEdit} onReset={() => setCanvasEdit(null)} onClose={() => setCanvasOpen(false)} />
        : railOpen && <Rail t={thread} st={st} space={space} onClose={toggleRail} onMedia={(url) => setOverlay({ kind: "image", url })} />}

      {overlay?.kind === "models" && <ModelPicker onClose={() => setOverlay(null)} onKeys={() => setOverlay({ kind: "settings", tab: "keys" })} toast={toast} />}
      {overlay?.kind === "settings" && <Settings st={st} start={overlay.tab} onClose={() => setOverlay(null)} toast={toast} theme={theme} setTheme={setTheme} />}
      {overlay?.kind === "usage" && <UsageView onClose={() => setOverlay(null)} />}
      {overlay?.kind === "project" && (
        <ProjectChooser st={st} propose={overlay.propose} toast={toast} onClose={() => setOverlay(null)}
          onDone={() => { const t = overlay.text; setOverlay(null); dispatch({ t: "set", s: emptyThread() }); reload(); if (t || images.length) setTimeout(() => send(t ?? "", "work"), 300); }} />
      )}
      {overlay?.kind === "image" && <Lightbox url={overlay.url} onClose={() => setOverlay(null)} />}
      {perm && <PermModal perm={perm} onDecide={(d) => { post("/api/perm", { id: perm.id, decision: d }).catch(() => {}); setPerm(null); }} />}
      <div class="toasts" aria-live="polite">{toasts.map((t) => <div class={`toast ${t.level}`}>{t.text}</div>)}</div>
    </div>
  );
}
