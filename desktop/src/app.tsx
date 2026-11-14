// Eclipse Desktop : barre latérale des conversations, fil de discussion, saisie, et réglages.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, events, isDesktop, type Info, type PermissionEvent, type State, type TranscriptItem, type Usage } from "./api";
import { I } from "./icons";
import { ConnectionsModal, DEFAULT_PREFS, ModelPicker, SettingsModal, UsagePanel, type Prefs } from "./panels";
import { Thread, type Item } from "./thread";
import { UpdateDialog, UpdatePill, UpdateSettings, startUpdates } from "./updates";

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("eclipse.prefs") || "{}") }; } catch { return DEFAULT_PREFS; }
}

function fromTranscript(t: TranscriptItem[]): Item[] {
  return t.map((x) => (x.kind === "tool" ? { ...x } : { kind: x.kind, text: x.text })) as Item[];
}

function group(ts: number): string {
  const d = new Date(ts * 1000), now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  return days <= 0 ? "Aujourd'hui" : days === 1 ? "Hier" : days < 7 ? "7 derniers jours" : days < 30 ? "30 derniers jours" : "Plus ancien";
}

export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<State>({ open: false, version: "" });
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<PermissionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [panel, setPanel] = useState<"" | "usage">("");
  const [modal, setModal] = useState<"" | "connections" | "settings" | "update">("");
  const [picker, setPicker] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState("");
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [text, setText] = useState("");
  const [newDir, setNewDir] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  const setPrefs = (p: Prefs) => { setPrefsState(p); try { localStorage.setItem("eclipse.prefs", JSON.stringify(p)); } catch { /* indisponible */ } };
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(""), 4000); };

  // Thème et taille du texte
  useEffect(() => {
    const dark = prefs.theme === "dark" || (prefs.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.fontSize = `${prefs.fontSize}px`;
  }, [prefs]);

  const refreshInfo = useCallback(() => api.info().then(setInfo).catch(() => undefined), []);
  const refreshUsage = useCallback(() => api.usage().then(setUsage).catch(() => setUsage(null)), []);
  const refreshState = useCallback(async () => {
    const s = await api.state();
    setState(s); setBusy(Boolean(s.busy)); setPending(s.pending_permissions ?? []);
    return s;
  }, []);
  const loadConversation = useCallback(async () => {
    const s = await refreshState();
    if (s.open) {
      setItems(fromTranscript((await api.transcript()).items));
      refreshUsage();
    } else setItems([]);
  }, []);

  // Démarrage : informations, conversation éventuellement déjà ouverte, flux d'événements.
  useEffect(() => {
    refreshInfo();
    loadConversation();
    if (isDesktop) startUpdates();
    return events(onEvent, (ok) => { setOnline(ok); if (ok) { refreshState(); } });
  }, []);

  const onEvent = (e: any) => {
    switch (e.type) {
      case "delta":
        setItems((xs) => {
          const last = xs[xs.length - 1];
          if (last?.kind === "assistant" && last.live) return [...xs.slice(0, -1), { ...last, text: last.text + e.text }];
          return [...xs.map((x) => (x.kind === "thinking" && x.live ? { ...x, live: false } : x)), { kind: "assistant", text: e.text, live: true }];
        });
        break;
      case "message":
        setItems((xs) => {
          const last = xs[xs.length - 1];
          if (last?.kind === "assistant" && last.live) return [...xs.slice(0, -1), { kind: "assistant", text: e.text || last.text }];
          return e.text ? [...xs, { kind: "assistant", text: e.text }] : xs;
        });
        break;
      case "thinking":
        setItems((xs) => {
          const last = xs[xs.length - 1];
          if (last?.kind === "thinking" && last.live) return [...xs.slice(0, -1), { ...last, text: last.text + e.text }];
          return [...xs, { kind: "thinking", text: e.text, live: true }];
        });
        break;
      case "tool_start":
        setItems((xs) => [...xs.map((x) => ((x.kind === "assistant" || x.kind === "thinking") && x.live ? { ...x, live: false } : x)),
          { kind: "tool", id: e.id, name: e.name, args: e.args ?? {}, output: null, ok: null }]);
        break;
      case "tool_end":
        setItems((xs) => xs.map((x) => (x.kind === "tool" && x.id === e.id ? { ...x, output: e.output ?? "", ok: e.ok } : x)));
        break;
      case "diff":
        setItems((xs) => {
          let found = false;
          const ys = xs.map((x) => { if (x.kind === "tool" && x.id === e.id) { found = true; return { ...x, diff: e.diff }; } return x; });
          return found ? ys : [...ys, { kind: "tool", id: e.id, name: "edit_file", args: { path: e.path }, output: "", ok: true, diff: e.diff }];
        });
        break;
      case "status":
        setItems((xs) => [...xs, { kind: "note", text: e.text, level: e.level }]);
        break;
      case "paused":
        setItems((xs) => [...xs, { kind: "note", text: `En pause : ${e.reason}`, level: "warn" }]);
        break;
      case "permission":
        setPending((ps) => (ps.some((p) => p.id === e.id) ? ps : [...ps, e]));
        break;
      case "permission_closed":
        setPending((ps) => ps.filter((p) => p.id !== e.id));
        break;
      case "todos":
        setState((s) => ({ ...s, todos: e.todos }));
        break;
      case "idle":
        setBusy(false);
        setItems((xs) => xs.map((x) => ((x.kind === "assistant" || x.kind === "thinking") && x.live ? { ...x, live: false } : x)));
        refreshInfo();
        refreshState();
        break;
      case "state":
        refreshState();
        break;
      case "usage":
        refreshUsage();
        break;
    }
  };

  // --- actions --------------------------------------------------------------------------------------------------------
  const openWorkspace = async (workspace: string) => {
    try { await api.open({ workspace }); await loadConversation(); refreshInfo(); setNewDir(""); input.current?.focus(); }
    catch (e: any) { say(e.message); }
  };
  const resume = async (id: string) => {
    if (state.session?.id === id) return;
    try { await api.open({ resume: id }); await loadConversation(); refreshInfo(); }
    catch (e: any) { say(e.message); }
  };
  const pickFolder = async () => {
    if (isDesktop) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "Dossier du projet" });
      if (typeof dir === "string") openWorkspace(dir);
    }
  };
  const newConversation = () => {
    if (state.open && state.session) openWorkspace(state.session.workspace);
  };
  const send = async () => {
    const t = text.trim();
    if (!t || busy || !state.open) return;
    setItems((xs) => [...xs, { kind: "user", text: t }]);
    setText("");
    setBusy(true);
    try { await api.prompt(t); } catch (e: any) { setBusy(false); say(e.message); }
  };
  const remove = async (id: string, title: string) => {
    if (!confirm(`Supprimer la conversation « ${title} » ? Les archives de la mémoire du projet sont conservées.`)) return;
    try { await api.remove(id); refreshInfo(); } catch (e: any) { say(e.message); }
  };
  const rename = async () => {
    const t = prompt("Titre de la conversation", state.session?.title || "");
    if (t !== null) { await api.rename(t); refreshState(); refreshInfo(); }
  };

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const out = new Map<string, Info["sessions"]>();
    for (const s of info?.sessions ?? []) {
      if (f && !(s.title.toLowerCase().includes(f) || s.workspace.toLowerCase().includes(f))) continue;
      const g = group(s.updated);
      out.set(g, [...(out.get(g) ?? []), s]);
    }
    return [...out.entries()];
  }, [info, filter]);

  const welcome = (
    <div class="welcome">
      <div class="logo"><span class="ico">{I.eclipse}</span></div>
      <h1>{state.open ? "Que voulez-vous faire ?" : "Bonjour"}</h1>
      {state.open ? (
        <p class="muted">Projet <b>{basename(state.session!.workspace)}</b> · {state.mode_label}{state.model ? ` · ${state.model}` : ""}.
          {!state.configured && <> <button class="link" onClick={() => setModal("connections")}>Configurer une connexion</button> pour commencer.</>}</p>
      ) : (
        <>
          <p class="muted">Choisissez le dossier du projet sur lequel Eclipse va travailler.</p>
          <div class="dirs">
            {isDesktop && <button class="dir primary" onClick={pickFolder}><span class="ico">{I.folder}</span> Ouvrir un dossier…</button>}
            {(info?.recent_dirs ?? []).map((d) => (
              <button key={d} class="dir" onClick={() => openWorkspace(d)} title={d}><span class="ico">{I.folder}</span> {basename(d)}<span class="muted small">{d}</span></button>
            ))}
          </div>
          <form class="dir-input" onSubmit={(e) => { e.preventDefault(); if (newDir.trim()) openWorkspace(newDir.trim()); }}>
            <input placeholder={`Chemin du projet (ex. ${info?.home ?? "~"}/Projets/mon-projet)`} value={newDir} onInput={(e) => setNewDir((e.target as HTMLInputElement).value)} />
            <button class="btn">Ouvrir</button>
          </form>
        </>
      )}
    </div>
  );

  const effort = state.effort;
  return (
    <div class={`app ${sidebar ? "" : "no-sidebar"} ${panel ? "with-panel" : ""}`}>
      {/* Barre latérale */}
      <nav class="sidebar" aria-label="Conversations">
        <div class="side-top">
          <span class="brand"><span class="ico">{I.eclipse}</span> Eclipse</span>
          <button class="icon-btn" title="Masquer la barre latérale" onClick={() => setSidebar(false)}><span class="ico">{I.sidebar}</span></button>
        </div>
        <button class="new" onClick={state.open ? newConversation : pickFolder} disabled={!state.open && !isDesktop}><span class="ico">{I.plus}</span> Nouvelle conversation</button>
        {state.open && <button class="new ghost" onClick={() => { setState({ ...state, open: false }); setItems([]); }}><span class="ico">{I.folder}</span> Autre projet…</button>}
        <div class="side-search"><span class="ico">{I.search}</span><input placeholder="Rechercher" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} /></div>
        <div class="side-list">
          {groups.map(([g, list]) => (
            <div key={g}>
              <div class="side-group">{g}</div>
              {list.map((s) => (
                <div key={s.id} class={`conv ${state.session?.id === s.id ? "on" : ""}`} onClick={() => resume(s.id)} role="button" tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && resume(s.id)}>
                  <span class="conv-title">{s.title}</span>
                  <span class="conv-dir">{basename(s.workspace)}</span>
                  <button class="icon-btn del" title="Supprimer" onClick={(e) => { e.stopPropagation(); remove(s.id, s.title); }}><span class="ico">{I.trash}</span></button>
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p class="muted small pad">Aucune conversation.</p>}
        </div>
        <div class="side-bottom">
          <button class="side-btn" onClick={() => setModal("connections")} disabled={!state.open}><span class="ico">{I.plug}</span> Connexions</button>
          <button class="side-btn" onClick={() => setModal("settings")}><span class="ico">{I.settings}</span> Réglages</button>
        </div>
      </nav>

      {/* Zone principale */}
      <main class="main">
        <header class="topbar">
          {!sidebar && <button class="icon-btn" title="Afficher la barre latérale" onClick={() => setSidebar(true)}><span class="ico">{I.sidebar}</span></button>}
          {state.open ? (
            <>
              <button class="title" onClick={rename} title="Renommer">{state.session?.title || "Nouvelle conversation"}</button>
              <span class="chip" title={state.session?.workspace}><span class="ico">{I.folder}</span> {basename(state.session!.workspace)}</span>
            </>
          ) : <span class="title muted">Eclipse</span>}
          <span class="spacer" />
          {!online && <span class="chip warn"><span class="ico">{I.warn}</span> moteur déconnecté</span>}
          {isDesktop && <UpdatePill onOpen={() => setModal("update")} />}
          {state.open && (
            <>
              <button class="icon-btn" title="Annuler le dernier échange" disabled={busy} onClick={async () => { const r = await api.undo(); if (r.ok) setItems(fromTranscript(r.items)); else say("Rien à annuler."); }}><span class="ico">{I.undo}</span></button>
              <button class={`icon-btn ${panel === "usage" ? "on" : ""}`} title="Consommation" onClick={() => { setPanel(panel === "usage" ? "" : "usage"); refreshUsage(); }}><span class="ico">{I.graph}</span></button>
            </>
          )}
        </header>

        <Thread items={items} pending={pending} busy={busy} empty={welcome}
          onDecide={(id, d) => api.permission(id, d).catch((e) => say(e.message))} />

        {state.open && (
          <div class="composer-wrap">
            {state.todos && state.todos.length > 0 && (
              <div class="todos">{state.todos.map((t) => <span key={t.id} class={`todo ${t.status}`}>{t.content}</span>)}</div>
            )}
            <div class="composer">
              <textarea ref={input} rows={1} value={text} placeholder={state.configured ? "Écrivez à Eclipse…  (@fichier pour joindre un fichier)" : "Configurez d'abord une connexion (Connexions)"}
                onInput={(e) => { const t = e.target as HTMLTextAreaElement; setText(t.value); t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 280)}px`; }}
                onKeyDown={(e) => {
                  const sendKey = prefs.enterSends ? e.key === "Enter" && !e.shiftKey : e.key === "Enter" && (e.ctrlKey || e.metaKey);
                  if (sendKey && !e.isComposing) { e.preventDefault(); send(); }
                  if (e.key === "Escape" && busy) api.interrupt();
                }} />
              <div class="composer-bar">
                <div class="seg small">
                  {(state.agents ?? ["build", "plan"]).filter((a) => a === "build" || a === "plan" || a === state.session?.agent).map((a) => (
                    <button key={a} class={state.session?.agent === a ? "on" : ""} title={a === "plan" ? "Plan : lecture seule, aucune modification" : "Build : peut modifier et exécuter (avec autorisation)"}
                      onClick={async () => setState(await api.agent(a))}>{a === "build" ? "Build" : a === "plan" ? "Plan" : a}</button>
                  ))}
                </div>
                <span class="spacer" />
                {effort && (
                  <select class="select" title="Effort du modèle" value={String(effort.current ?? "")}
                    onChange={async (e) => { const v = (e.target as HTMLSelectElement).value; setState(await api.effort(v || null)); }}>
                    <option value="">effort : défaut</option>
                    {effort.choices.map((c) => <option key={c} value={c}>effort : {c}</option>)}
                  </select>
                )}
                <div class="model-wrap">
                  <button class="model-btn" onClick={() => setPicker(!picker)} title="Modèle">
                    <span class="muted">{state.mode_label}</span> {state.model || "choisir un modèle"} <span class="ico small">{I.chevron}</span>
                  </button>
                  {picker && <ModelPicker state={state} onClose={() => setPicker(false)}
                    onPick={async (m) => { setPicker(false); try { setState(await api.model(m)); } catch (e: any) { say(e.message); } }} />}
                </div>
                {busy ? (
                  <button class="send stop" title="Arrêter (Échap)" onClick={() => api.interrupt()}><span class="ico">{I.stop}</span></button>
                ) : (
                  <button class="send" title="Envoyer" disabled={!text.trim()} onClick={send}><span class="ico">{I.send}</span></button>
                )}
              </div>
            </div>
            <p class="disclaimer">Les commandes et modifications de fichiers vous sont toujours montrées avant d'être exécutées.</p>
          </div>
        )}
      </main>

      {panel === "usage" && <UsagePanel usage={usage} onClose={() => setPanel("")} />}

      {modal === "connections" && <ConnectionsModal onClose={() => setModal("")}
        onConnected={(s, msg) => { setState(s); setModal(""); say(msg); if (!s.model && !s.is_cli) setPicker(true); }} />}
      {modal === "settings" && <SettingsModal prefs={prefs} setPrefs={setPrefs} version={info?.version ?? ""} onClose={() => setModal("")} updates={<UpdateSettings />} />}
      {modal === "update" && <UpdateDialog onClose={() => setModal("")} />}
      {picker && <div class="click-away" onMouseDown={() => setPicker(false)} />}
      {toast && <div class="toast" role="status">{toast}</div>}
    </div>
  );
}
