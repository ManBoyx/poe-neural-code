// Eclipse Desktop : barre latérale des conversations, fil de discussion, saisie, et réglages.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, events, isDesktop, type Info, type PermissionEvent, type State, type TranscriptItem, type Upload, type Usage } from "./api";
import { I } from "./icons";
import { ConnectionsModal, DEFAULT_PREFS, ModelPicker, SettingsModal, UsageBody, type Prefs } from "./panels";
import { Dialog, FilePreviewModal, FilesPanel, MemoryPanel, Palette, type Command, type DialogSpec } from "./side";
import { Thread, type Item } from "./thread";
import { UpdateDialog, UpdatePill, UpdateSettings, startUpdates } from "./updates";

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

const kfmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} k` : String(n));

function readAsBase64(f: File): Promise<string> {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => ko(r.error);
    r.readAsDataURL(f);
  });
}

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
  const [panel, setPanel] = useState<"" | "usage" | "memory" | "files">("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [palette, setPalette] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
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
  const ask = (spec: Omit<DialogSpec, "resolve">) => new Promise<string | boolean | null>((resolve) => setDialog({ ...spec, resolve }));

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
        setRefreshKey((k) => k + 1);
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
        setRefreshKey((k) => k + 1);
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
  const newDiscussion = async () => {
    try { await api.newDiscussion(); await loadConversation(); refreshInfo(); input.current?.focus(); }
    catch (e: any) { say(e.message); }
  };
  const newConversation = () => {
    if (state.open && state.session) openWorkspace(state.session.workspace);
  };
  const send = async () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || busy || !state.open) return;
    const texts = attachments.filter((a): a is Extract<Upload, { kind: "text" }> => a.kind === "text");
    const images = attachments.filter((a): a is Extract<Upload, { kind: "image" }> => a.kind === "image");
    const fence = "`".repeat(3);
    const full = [t || "Voici les pièces jointes.", ...texts.map((a) => `\n\nFichier joint « ${a.name} » :\n${fence}\n${a.text}\n${fence}`)].join("");
    const shown = t + (attachments.length ? `${t ? "\n" : ""}[pièces jointes : ${attachments.map((a) => a.name).join(", ")}]` : "");
    setItems((xs) => [...xs, { kind: "user", text: shown }]);
    setText(""); setAttachments([]);
    if (input.current) input.current.style.height = "auto";
    setBusy(true);
    try { await api.prompt(full, images.map((a) => a.path)); } catch (e: any) { setBusy(false); say(e.message); }
  };
  const attach = async (files: FileList | File[]) => {
    if (!state.open) return;
    for (const f of Array.from(files)) {
      if (f.size > 15 * 1024 * 1024) { say(`${f.name} : trop gros (15 Mo au maximum).`); continue; }
      try { const u = await api.upload(f.name || "image.png", await readAsBase64(f)); setAttachments((xs) => [...xs, u]); }
      catch (e: any) { say(`${f.name} : ${e.message}`); }
    }
  };
  const retry = async () => {
    try {
      const r = await api.retry();
      setItems([...fromTranscript(r.items), { kind: "user", text: r.text }]);
      setBusy(true);
    } catch (e: any) { say(e.message); }
  };
  const togglePanel = (p: "usage" | "memory" | "files") => { setPanel(panel === p ? "" : p); if (p === "usage") refreshUsage(); setRefreshKey((k) => k + 1); };
  const remove = async (id: string, title: string) => {
    if (!(await ask({ title: "Supprimer la conversation ?", message: `« ${title} » sera retirée de la liste. Les fichiers du dossier et la mémoire du projet sont conservés.`, confirm: "Supprimer", danger: true }))) return;
    try { await api.remove(id); refreshInfo(); } catch (e: any) { say(e.message); }
  };
  const rename = async () => {
    const t = await ask({ title: "Renommer la conversation", input: state.session?.title || "", confirm: "Renommer" });
    if (typeof t === "string") { await api.rename(t); refreshState(); refreshInfo(); }
  };

  // Raccourcis clavier globaux
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) { e.preventDefault(); if (!busy) newDiscussion(); }
      else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); setSidebar((v) => !v); }
      else if (mod && e.key === ",") { e.preventDefault(); setModal("settings"); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [busy]);

  const commands: Command[] = [
    { id: "new", label: "Nouvelle discussion", hint: "Ctrl+N", icon: I.plus, run: newDiscussion, enabled: !busy },
    { id: "conv", label: "Nouvelle conversation dans ce dossier", icon: I.chat, run: newConversation, enabled: state.open && !busy },
    { id: "open", label: "Ouvrir un projet…", icon: I.folder, run: () => { setState({ ...state, open: false }); setItems([]); }, enabled: !busy },
    { id: "model", label: "Changer de modèle", icon: I.agent, run: () => setPicker(true), enabled: state.open },
    { id: "conn", label: "Connexions (agents et clés d'API)", icon: I.plug, run: () => setModal("connections"), enabled: state.open },
    { id: "mem", label: "Mémoire du dossier", icon: I.brain, run: () => togglePanel("memory"), enabled: state.open },
    { id: "files", label: "Fichiers du dossier", icon: I.files, run: () => togglePanel("files"), enabled: state.open },
    { id: "usage", label: "Consommation", icon: I.graph, run: () => togglePanel("usage"), enabled: state.open },
    { id: "build", label: "Mode Build (peut modifier)", icon: I.tools, run: async () => setState(await api.agent("build")), enabled: state.open },
    { id: "plan", label: "Mode Plan (lecture seule)", icon: I.search, run: async () => setState(await api.agent("plan")), enabled: state.open },
    { id: "auto", label: state.auto_edits ? "Désactiver les modifications automatiques" : "Activer les modifications automatiques", icon: I.edit,
      run: async () => setState(await api.autoEdits(!state.auto_edits)), enabled: state.open },
    { id: "retry", label: "Relancer le dernier message", icon: I.retry, run: retry, enabled: state.open && !busy },
    { id: "undo", label: "Annuler le dernier échange", icon: I.undo, enabled: state.open && !busy,
      run: async () => { const r = await api.undo(); if (r.ok) setItems(fromTranscript(r.items)); else say("Rien à annuler."); } },
    { id: "rename", label: "Renommer la conversation", icon: I.edit, run: rename, enabled: state.open },
    { id: "theme", label: "Changer de thème (sombre / clair)", icon: I.palette,
      run: () => setPrefs({ ...prefs, theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }) },
    { id: "side", label: "Afficher / masquer la barre latérale", hint: "Ctrl+B", icon: I.sidebar, run: () => setSidebar((v) => !v) },
    { id: "settings", label: "Réglages", hint: "Ctrl+,", icon: I.settings, run: () => setModal("settings") },
  ];

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
      ) : null}
      {state.open ? (
        <div class="explain">
          <div><span class="ico">{I.folder}</span><b>Dossier de travail</b><span>L'IA crée ses fichiers dans <code>{state.session!.workspace}</code>. Chaque écriture vous est montrée avant d'être faite.</span></div>
          <div><span class="ico">{I.graph}</span><b>Économie de tokens</b><span>Quel que soit le fournisseur, l'IA reçoit le guide d'Eclipse : elle note l'essentiel dans la mémoire du dossier, recherche au lieu de tout relire, lit les fichiers par morceaux. Le fil ancien est résumé automatiquement.</span></div>
          <div><span class="ico">{I.chat}</span><b>Conversations suivantes</b><span>Avec le bouton + en haut, une nouvelle conversation dans ce dossier repart de sa mémoire sans tout renvoyer.</span></div>
        </div>
      ) : (
        <>
          <p class="muted">Démarrez une discussion : Eclipse lui crée son propre dossier de travail. Ou ouvrez un projet existant.</p>
          <button class="btn primary big" onClick={newDiscussion}><span class="ico">{I.plus}</span> Nouvelle discussion</button>
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
    <div class={`app ${sidebar ? "" : "no-sidebar"} ${panel && state.open ? "with-panel" : ""}`}>
      {/* Barre latérale */}
      <nav class="sidebar" aria-label="Conversations">
        <div class="side-top">
          <span class="brand"><span class="ico">{I.eclipse}</span> Eclipse</span>
          <button class="icon-btn" title="Masquer la barre latérale" onClick={() => setSidebar(false)}><span class="ico">{I.sidebar}</span></button>
        </div>
        <button class="new" onClick={newDiscussion} disabled={busy} title={`Crée un dossier de travail dans ${info?.discussions_dir ?? "~/Projets/Eclipse"}`}><span class="ico">{I.plus}</span> Nouvelle discussion</button>
        <button class="new ghost" onClick={() => { setState({ ...state, open: false }); setItems([]); }} disabled={busy}><span class="ico">{I.folder}</span> Ouvrir un projet…</button>
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
      <main class={`main ${dragOver ? "drag" : ""}`}
        onDragOver={(e) => { if (state.open && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer?.files.length) attach(e.dataTransfer.files); }}>
        <header class="topbar">
          {!sidebar && <button class="icon-btn" title="Afficher la barre latérale" onClick={() => setSidebar(true)}><span class="ico">{I.sidebar}</span></button>}
          {state.open ? (
            <>
              <button class="title" onClick={rename} title="Renommer">{state.session?.title || "Nouvelle conversation"}</button>
              <span class="chip" title={state.session?.workspace}><span class="ico">{I.folder}</span> {basename(state.session!.workspace)}</span>
              <button class="icon-btn" title="Nouvelle conversation dans ce dossier (même mémoire)" disabled={busy} onClick={newConversation}><span class="ico">{I.plus}</span></button>
            </>
          ) : <span class="title muted">Eclipse</span>}
          <span class="spacer" />
          <button class="icon-btn" title="Commandes (Ctrl+K)" onClick={() => setPalette(true)}><span class="ico">{I.palette}</span></button>
          {!online && <span class="chip warn"><span class="ico">{I.warn}</span> moteur déconnecté</span>}
          {isDesktop && <UpdatePill onOpen={() => setModal("update")} />}
          {state.open && (
            <>
              <button class="icon-btn" title="Annuler le dernier échange" disabled={busy} onClick={async () => { const r = await api.undo(); if (r.ok) setItems(fromTranscript(r.items)); else say("Rien à annuler."); }}><span class="ico">{I.undo}</span></button>
              <button class={`icon-btn ${panel === "memory" ? "on" : ""}`} title="Mémoire du dossier" onClick={() => togglePanel("memory")}><span class="ico">{I.brain}</span></button>
              <button class={`icon-btn ${panel === "files" ? "on" : ""}`} title="Fichiers du dossier" onClick={() => togglePanel("files")}><span class="ico">{I.files}</span></button>
              <button class={`icon-btn ${panel === "usage" ? "on" : ""}`} title="Consommation" onClick={() => togglePanel("usage")}><span class="ico">{I.graph}</span></button>
            </>
          )}
        </header>

        <Thread items={items} pending={pending} busy={busy} empty={welcome} onRetry={state.open ? retry : undefined}
          onDecide={(id, d) => api.permission(id, d).catch((e) => say(e.message))} />

        {state.open && (
          <div class="composer-wrap">
            {state.todos && state.todos.length > 0 && (
              <div class="todos">{state.todos.map((t) => <span key={t.id} class={`todo ${t.status}`}>{t.content}</span>)}</div>
            )}
            <div class="composer">
              {attachments.length > 0 && (
                <div class="atts">{attachments.map((a, i) => (
                  <span class="att" key={i} title={a.kind === "image" ? "Image envoyée au modèle" : "Contenu ajouté au message"}>
                    <span class="ico">{a.kind === "image" ? I.image : I.fileCode}</span>{a.name}
                    <button class="x" title="Retirer" onClick={() => setAttachments((xs) => xs.filter((_, j) => j !== i))}><span class="ico">{I.close}</span></button>
                  </span>))}</div>
              )}
              <textarea ref={input} rows={1} value={text} placeholder={state.configured ? "Écrivez à Eclipse…   (Ctrl+K : commandes)" : "Configurez d'abord une connexion (Connexions)"}
                onPaste={(e) => { const fs = Array.from(e.clipboardData?.files ?? []); if (fs.length) { e.preventDefault(); attach(fs); } }}
                onInput={(e) => { const t = e.target as HTMLTextAreaElement; setText(t.value); t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 280)}px`; }}
                onKeyDown={(e) => {
                  const sendKey = prefs.enterSends ? e.key === "Enter" && !e.shiftKey : e.key === "Enter" && (e.ctrlKey || e.metaKey);
                  if (sendKey && !e.isComposing) { e.preventDefault(); send(); }
                  if (e.key === "Escape" && busy) api.interrupt();
                }} />
              <div class="composer-bar">
                <label class="icon-btn" title="Joindre une image ou un fichier texte (ou glissez-le dans la fenêtre, ou collez une capture)">
                  <span class="ico">{I.clip}</span>
                  <input type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,.txt,.md,.py,.js,.ts,.tsx,.json,.csv,.log,.html,.css,.rs,.kt,.java,.c,.cpp,.h,.go,.sh,.yml,.yaml,.toml,.xml,.sql"
                    onChange={(e) => { const t = e.target as HTMLInputElement; if (t.files) attach(t.files); t.value = ""; }} />
                </label>
                <div class="seg small">
                  {(state.agents ?? ["build", "plan"]).filter((a) => a === "build" || a === "plan" || a === state.session?.agent).map((a) => (
                    <button key={a} class={state.session?.agent === a ? "on" : ""} title={a === "plan" ? "Plan : lecture seule, aucune modification" : "Build : peut modifier et exécuter (avec autorisation)"}
                      onClick={async () => setState(await api.agent(a))}>{a === "build" ? "Build" : a === "plan" ? "Plan" : a}</button>
                  ))}
                </div>
                <button class={`toggle ${state.auto_edits ? "on" : ""}`} title="Modifications auto : les créations et modifications de fichiers DANS le dossier sont appliquées sans demander (les commandes demandent toujours)."
                  onClick={async () => setState(await api.autoEdits(!state.auto_edits))}><span class="knob" /> Modifs auto</button>
                <span class="spacer" />
                {state.context && (state.context.window ? (
                  <span class="ctx" title={`Contexte envoyé au dernier tour : ${state.context.used} / ${state.context.window} tokens. Au-delà d'un seuil, l'ancien fil est résumé automatiquement.`}>
                    <span class="ctx-bar"><span style={{ width: `${Math.min(100, (state.context.used / state.context.window) * 100)}%` }} /></span>
                    {kfmt(state.context.used)} / {kfmt(state.context.window)}
                  </span>
                ) : state.context.used ? <span class="ctx" title="Tokens du dernier tour">{kfmt(state.context.used)} tok</span> : null)}
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
                  <button class="send" title="Envoyer" disabled={!text.trim() && attachments.length === 0} onClick={send}><span class="ico">{I.send}</span></button>
                )}
              </div>
            </div>
            <p class="disclaimer">{state.auto_edits ? "Modifications de fichiers appliquées automatiquement dans le dossier ; les commandes vous sont toujours montrées avant exécution." : "Les commandes et modifications de fichiers vous sont toujours montrées avant d'être exécutées."}</p>
          </div>
        )}
      </main>

      {panel && state.open && (
        <aside class="drawer" aria-label="Panneau latéral">
          <header class="tabs">
            <button class={panel === "memory" ? "on" : ""} onClick={() => setPanel("memory")}><span class="ico">{I.brain}</span> Mémoire</button>
            <button class={panel === "files" ? "on" : ""} onClick={() => setPanel("files")}><span class="ico">{I.files}</span> Fichiers</button>
            <button class={panel === "usage" ? "on" : ""} onClick={() => { setPanel("usage"); refreshUsage(); }}><span class="ico">{I.graph}</span> Conso</button>
            <span class="spacer" />
            <button class="icon-btn" onClick={() => setPanel("")} title="Fermer"><span class="ico">{I.close}</span></button>
          </header>
          {panel === "memory" && <MemoryPanel ask={ask} refreshKey={refreshKey} />}
          {panel === "files" && <FilesPanel onOpen={setPreview} refreshKey={refreshKey} />}
          {panel === "usage" && (usage ? <UsageBody u={usage} /> : <p class="muted pad">Chargement…</p>)}
        </aside>
      )}

      {modal === "connections" && <ConnectionsModal onClose={() => setModal("")}
        onConnected={(s, msg) => { setState(s); setModal(""); say(msg); if (!s.model && !s.is_cli) setPicker(true); }} />}
      {modal === "settings" && <SettingsModal prefs={prefs} setPrefs={setPrefs} version={info?.version ?? ""} onClose={() => setModal("")} updates={<UpdateSettings />}
        discussionsDir={info?.discussions_dir ?? ""}
        onSaveDir={async (d) => { try { await api.settings({ discussions_dir: d }); refreshInfo(); return null; } catch (e: any) { return e.message; } }} />}
      {modal === "update" && <UpdateDialog onClose={() => setModal("")} />}
      {picker && <div class="click-away" onMouseDown={() => setPicker(false)} />}
      {preview && <FilePreviewModal path={preview} onClose={() => setPreview(null)} />}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {dialog && <Dialog spec={dialog} onDone={() => setDialog(null)} />}
      {dragOver && <div class="drop-hint"><span class="ico">{I.clip}</span> Déposez pour joindre</div>}
      {toast && <div class="toast" role="status">{toast}</div>}
    </div>
  );
}
