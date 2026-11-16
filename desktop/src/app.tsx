// Eclipse Desktop : barre latérale des conversations, fil de discussion, saisie, et réglages.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, connect, events, health, isDesktop, openLogs, restartEngine, type FileEntry, type Info, type PermissionEvent, type PromptCommand, type SearchResult, type State, type TranscriptItem, type Upload, type Usage } from "./api";
import { I } from "./icons";
import { ConnectionsModal, DEFAULT_PREFS, ModelPicker, SettingsModal, UsageBody, type Prefs } from "./panels";
import { ChangesModal, Dialog, HelpModal, FilePreviewModal, FilesPanel, MemoryPanel, Palette, Suggest, type Command, type DialogSpec, type Suggestion } from "./side";
import { Thread, type Item } from "./thread";
import { UpdateDialog, UpdatePill, UpdateSettings, startUpdates } from "./updates";

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

const fsize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
const REF_RX = /(^|\s)@([\w./\-]+)/g;
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

function loadList(k: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(k) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function saveList(k: string, v: string[]) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } }
function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "maintenant";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} j`;
  return new Date(ts * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export function App() {
  const [phase, setPhase] = useState<"connecting" | "ready" | "failed">("connecting");
  const [bootError, setBootError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [down, setDown] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const unsub = useRef<(() => void) | null>(null);
  const updatesStarted = useRef(false);
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
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [promptCmds, setPromptCmds] = useState<PromptCommand[]>([]);
  const [sug, setSug] = useState<{ items: Suggestion[]; sel: number; kind: "file" | "cmd"; start: number; end: number } | null>(null);
  const [hits, setHits] = useState<SearchResult[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [detected, setDetected] = useState<{ id: string; label: string }[]>([]);
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
  // Rafraîchissements en arrière-plan : un échec (moteur en panne) est signalé par la bannière, pas par une exception.
  // Un instantané d'état demandé AVANT un événement ne doit pas effacer ce que cet événement a apporté
  // (ex. une demande d'autorisation arrivée pendant la requête) : on compte les événements reçus.
  const evSeq = useRef(0);
  const refreshState = useCallback(async function refresh(authoritative = false, attempt = 0): Promise<State | null> {
    const seq = evSeq.current;
    try {
      const s = await api.state();
      if (seq === evSeq.current) {
        setState(s);
        setBusy(Boolean(s.busy));
        setPending(s.pending_permissions ?? []);
      } else if (authoritative && attempt < 3) {
        return refresh(true, attempt + 1);  // des événements sont arrivés pendant la requête : instantané périmé, on redemande
      } else {
        setState((cur) => ({ ...s, busy: cur.busy }));
        setPending((ps) => [...ps, ...(s.pending_permissions ?? []).filter((x) => !ps.some((p) => p.id === x.id))]);
      }
      return s;
    } catch { return null; }
  }, []);
  const loadConversation = useCallback(async () => {
    const s = await refreshState();
    if (!s) return;
    if (s.open) {
      try { setItems(fromTranscript((await api.transcript()).items)); } catch { /* bannière */ }
      refreshUsage();
    } else setItems([]);
  }, []);

  // --- cycle de vie du moteur : démarrage, panne, relance -----------------------------------------------------------
  const attach_ = () => {
    unsub.current?.();
    unsub.current = events(onEvent, (ok) => {
      setOnline(ok);
      if (ok) { setDown(false); refreshState(true); }  // (re)connexion : l'état du moteur fait foi
      else setTimeout(async () => { if (!(await health())) setDown(true); }, 1500);
    });
  };
  const init = async () => {
    attach_();
    await Promise.all([refreshInfo(), loadConversation()]);
    if (isDesktop && !updatesStarted.current) { updatesStarted.current = true; startUpdates(); }
  };
  const boot = async () => {
    setPhase("connecting"); setBootError(""); setElapsed(0);
    const t0 = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      await connect();
      setPhase("ready");
      await init();
    } catch (e: any) {
      setBootError(String(e?.message ?? e));
      setPhase("failed");
    } finally { clearInterval(tick); }
  };
  const restart = async () => {
    setRestarting(true);
    try {
      if (isDesktop) {
        await restartEngine();
        setPhase("ready"); setDown(false); setBusy(false); setPending([]);
        await init();
        say("Moteur relancé. Une réponse en cours a pu être perdue : relancez-la si besoin.");
      } else if (await health()) {
        setDown(false); setPhase("ready"); await init();
      } else say("Le moteur ne répond toujours pas : relancez « eclipse web » dans un terminal.");
    } catch (e: any) {
      setBootError(String(e?.message ?? e)); setPhase("failed");
    } finally { setRestarting(false); }
  };
  useEffect(() => {
    boot();
    const hb = setInterval(async () => {
      if (document.visibilityState === "visible" && unsub.current && !(await health())) setDown(true);
    }, 15000);
    return () => { clearInterval(hb); unsub.current?.(); };
  }, []);

  const onEvent = (e: any) => {
    evSeq.current += 1;
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
    if (state.open && state.session?.id === id) return;
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
    if (t.startsWith("/") && attachments.length === 0) {
      const [name, ...rest] = t.slice(1).split(/\s+/);
      const args = rest.join(" ").trim();
      if (name in slash) { setText(""); setSug(null); await slash[name].run(args); return; }
      let known = promptCmds.some((c) => c.name === name);
      if (!known) {  // liste pas encore chargée (conversation tout juste ouverte) : on la redemande avant de conclure
        try { const r = await api.commands(); setPromptCmds(r.commands); known = r.commands.some((c) => c.name === name); } catch { /* moteur */ }
      }
      if (known) {
        setText(""); setSug(null); setItems((xs) => [...xs, { kind: "user", text: t }]); setBusy(true);
        try { await api.command(name, args); } catch (e: any) { setBusy(false); say(e.message); }
        return;
      }
      say(`Commande inconnue : /${name} (tapez / pour la liste)`);
      return;
    }
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
  const undoLast = async () => { try { const r = await api.undo(); if (r.ok) setItems(fromTranscript(r.items)); else say("Rien à annuler."); } catch (e: any) { say(e.message); } };
  const redoLast = async () => { try { const r = await api.redo(); if (r.ok) setItems(fromTranscript(r.items)); else say("Rien à rétablir."); } catch (e: any) { say(e.message); } };
  const editLast = async () => {
    try { const r = await api.editLast(); setItems(fromTranscript(r.items)); setText(r.text); input.current?.focus(); }
    catch (e: any) { say(e.message); }
  };
  const copyLast = () => {
    const last = [...items].reverse().find((x) => x.kind === "assistant") as { text: string } | undefined;
    if (last) { navigator.clipboard.writeText(last.text); say("Dernière réponse copiée."); } else say("Aucune réponse à copier.");
  };
  const compactNow = async () => { try { say((await api.compact()).message); setRefreshKey((k) => k + 1); } catch (e: any) { say(e.message); } };
  const forkConv = async () => { try { await api.fork(); await loadConversation(); refreshInfo(); say("Conversation dupliquée."); } catch (e: any) { say(e.message); } };
  const exportConv = async () => {
    try {
      const { markdown, filename } = await api.exportMd();
      if (isDesktop) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({ defaultPath: filename, filters: [{ name: "Markdown", extensions: ["md"] }], title: "Exporter la conversation" });
        if (path) say(`Exportée : ${(await api.exportTo(path)).path}`);
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
        a.download = filename; a.click(); URL.revokeObjectURL(a.href);
      }
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

  // Fichiers (pour @) et commandes-prompts (pour /) de la conversation ouverte
  useEffect(() => {
    if (phase !== "ready" || !state.open) { setFiles([]); setPromptCmds([]); return; }
    api.files().then((r) => setFiles(r.files)).catch(() => undefined);
    api.commands().then((r) => setPromptCmds(r.commands)).catch(() => undefined);
  }, [phase, state.session?.id, refreshKey]);

  // Agents installés sur l'ordinateur (Claude Code, OpenCode…) : proposés à l'accueil
  useEffect(() => {
    if (phase !== "ready" || !state.open) return;
    api.connections().then((c) => setDetected(c.agents.filter((a) => a.installed).map((a) => ({ id: a.id, label: a.label })))).catch(() => undefined);
  }, [phase, state.session?.id]);
  const quickConnect = async (id: string, label: string) => {
    try {
      const r = await api.connect(id);
      if (r.ok && r.state) { setState(r.state); say(`${label} sélectionné.`); } else say(r.message || "connexion impossible");
    } catch (e: any) { say(e.message); }
  };

  // Recherche dans le contenu des conversations (en plus des titres)
  useEffect(() => {
    const q = filter.trim();
    if (phase !== "ready" || q.length < 2) { setHits([]); return; }
    const t = setTimeout(() => api.search(q).then((r) => setHits(r.results)).catch(() => setHits([])), 300);
    return () => clearTimeout(t);
  }, [filter, phase]);

  // Commandes « / » de l'application (équivalents des commandes du CLI) ; les commandes-prompts viennent du moteur
  const slash: Record<string, { desc: string; args?: boolean; run: (args: string) => void | Promise<void> }> = {
    new: { desc: "Nouvelle conversation dans ce dossier", run: newConversation },
    discussion: { desc: "Nouvelle discussion (nouveau dossier de travail)", run: newDiscussion },
    models: { desc: "Choisir le modèle", run: () => setPicker(true) },
    model: { desc: "Choisir un modèle : /model NOM", args: true, run: async (a) => { if (!a) return setPicker(true); try { setState(await api.model(a)); } catch (e: any) { say(e.message); } } },
    connect: { desc: "Connexions : agents installés et clés d'API", run: () => setModal("connections") },
    mode: { desc: "Mode : /mode build | plan", args: true, run: async (a) => { try { setState(await api.agent(a || (state.session?.agent === "plan" ? "build" : "plan"))); } catch (e: any) { say(e.message); } } },
    undo: { desc: "Annuler le dernier échange (et ses fichiers)", run: undoLast },
    redo: { desc: "Rétablir l'échange annulé", run: redoLast },
    retry: { desc: "Relancer le dernier message", run: retry },
    edit: { desc: "Modifier le dernier message", run: editLast },
    export: { desc: "Exporter la conversation en Markdown", run: exportConv },
    diff: { desc: "Modifications des fichiers depuis le début (diff, tout annuler)", run: () => setChangesOpen(true) },
    compact: { desc: "Résumer l'ancien fil maintenant (archives conservées)", run: compactNow },
    fork: { desc: "Dupliquer la conversation", run: forkConv },
    copy: { desc: "Copier la dernière réponse", run: copyLast },
    rename: { desc: "Renommer la conversation", run: rename },
    memory: { desc: "Mémoire du dossier", run: () => togglePanel("memory") },
    files: { desc: "Fichiers du dossier", run: () => togglePanel("files") },
    usage: { desc: "Consommation", run: () => togglePanel("usage") },
    thinking: { desc: "Afficher / masquer la réflexion du modèle", run: () => setPrefs({ ...prefs, showThinking: !prefs.showThinking }) },
    auto: { desc: "Modifications automatiques : activer / désactiver", run: async () => setState(await api.autoEdits(!state.auto_edits)) },
    help: { desc: "Aide : raccourcis et commandes", run: () => setHelp(true) },
  };

  const refLimit = state.ref_limit ?? 40000;
  const updateSuggest = (value: string, caret: number) => {
    if (value.startsWith("/") && !value.slice(0, caret).includes(" ")) {
      const q = value.slice(1, caret).toLowerCase();
      const all: Suggestion[] = [
        ...Object.entries(slash).map(([n, v]) => ({ key: `a:${n}`, label: `/${n}`, detail: v.desc, icon: I.palette })),
        ...promptCmds.filter((c) => !(c.name in slash)).map((c) => ({ key: `p:${c.name}`, label: `/${c.name}`, detail: c.description, icon: I.chat })),
      ];
      const items = all.filter((x) => x.label.slice(1).toLowerCase().startsWith(q)).slice(0, 10);
      setSug(items.length ? { items, sel: 0, kind: "cmd", start: 0, end: caret } : null);
      return;
    }
    const m = value.slice(0, caret).match(/(^|\s)@([\w./\-]*)$/);
    if (m) {
      const q = m[2].toLowerCase();
      if (m[2] === "") {  // « @ » vient d'être tapé : liste des fichiers rafraîchie (fichiers créés entre-temps)
        api.files().then((r) => { setFiles(r.files); }).catch(() => undefined);
      }
      const items = files.filter((f) => f.path.toLowerCase().includes(q)).sort((a, b) => a.path.length - b.path.length).slice(0, 8)
        .map((f) => ({ key: `f:${f.path}`, label: `@${f.path}`, detail: fsize(f.size), icon: I.fileCode, warn: f.size > refLimit ? "sera tronqué" : undefined }));
      setSug(items.length ? { items, sel: 0, kind: "file", start: caret - m[2].length - 1, end: caret } : null);
      return;
    }
    setSug(null);
  };
  // La liste des fichiers vient d'être rechargée : recalcul des suggestions en cours (sinon elles restent périmées)
  useEffect(() => {
    const el = input.current;
    if (el && document.activeElement === el && /(^|\s)@[\w./\-]*$/.test(el.value.slice(0, el.selectionStart ?? el.value.length))) {
      updateSuggest(el.value, el.selectionStart ?? el.value.length);
    }
  }, [files]);
  const pickSuggest = (x: Suggestion) => {
    if (!sug) return;
    if (sug.kind === "cmd" && x.key.startsWith("a:") && !slash[x.key.slice(2)].args) {
      setText(""); setSug(null); slash[x.key.slice(2)].run("");
      return;
    }
    const insert = `${x.label} `;
    const next = text.slice(0, sug.start) + insert + text.slice(sug.end);
    setText(next); setSug(null);
    requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = sug.start + insert.length; } });
  };
  const refs = useMemo(() => {
    const out: { path: string; size: number | null }[] = [];
    for (const m of text.matchAll(REF_RX)) {
      const path = m[2].replace(/[.,;:!?]+$/, "");
      if (out.some((r) => r.path === path)) continue;
      out.push({ path, size: files.find((f) => f.path === path)?.size ?? null });
    }
    return out;
  }, [text, files]);

  // Raccourcis clavier globaux
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) { e.preventDefault(); if (!busy) newDiscussion(); }
      else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); setSidebar((v) => !v); }
      else if (mod && e.key === ",") { e.preventDefault(); setModal("settings"); }
      else if (e.key === "F1" || (mod && e.key === "/")) { e.preventDefault(); setHelp(true); }
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
    { id: "diff", label: "Modifications des fichiers (diff, tout annuler)", hint: "/diff", icon: I.diff, run: () => setChangesOpen(true), enabled: state.open },
    { id: "export", label: "Exporter la conversation en Markdown", hint: "/export", icon: I.export, run: exportConv, enabled: state.open },
    { id: "edit", label: "Modifier le dernier message", hint: "/edit", icon: I.edit, run: editLast, enabled: state.open && !busy },
    { id: "redo", label: "Rétablir l'échange annulé", hint: "/redo", icon: I.history, run: redoLast, enabled: state.open && !busy },
    { id: "copy", label: "Copier la dernière réponse", hint: "/copy", icon: I.copy, run: copyLast, enabled: state.open },
    { id: "compact", label: "Résumer l'ancien fil maintenant", hint: "/compact", icon: I.database, run: compactNow, enabled: state.open && !busy },
    { id: "fork", label: "Dupliquer la conversation", hint: "/fork", icon: I.newFile, run: forkConv, enabled: state.open && !busy },
    { id: "thinking", label: prefs.showThinking ? "Masquer la réflexion du modèle" : "Afficher la réflexion du modèle", hint: "/thinking", icon: I.thinking,
      run: () => setPrefs({ ...prefs, showThinking: !prefs.showThinking }) },
    ...promptCmds.map((c) => ({ id: `p-${c.name}`, label: `/${c.name} — ${c.description}`, icon: I.chat, enabled: state.open && !busy,
      run: () => { setText(`/${c.name} `); input.current?.focus(); } })),
    { id: "theme", label: "Changer de thème (sombre / clair)", icon: I.palette,
      run: () => setPrefs({ ...prefs, theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }) },
    { id: "side", label: "Afficher / masquer la barre latérale", hint: "Ctrl+B", icon: I.sidebar, run: () => setSidebar((v) => !v) },
    { id: "settings", label: "Réglages", hint: "Ctrl+,", icon: I.settings, run: () => setModal("settings") },
    { id: "help", label: "Aide : raccourcis et commandes", hint: "F1", icon: I.info, run: () => setHelp(true) },
  ];

  const [sideTab, setSideTab] = useState<"sessions" | "projects">("sessions");
  const [pins, setPins] = useState<string[]>(() => loadList("eclipse.pins"));
  const [tabs, setTabs] = useState<string[]>(() => loadList("eclipse.tabs"));
  useEffect(() => saveList("eclipse.pins", pins), [pins]);
  useEffect(() => saveList("eclipse.tabs", tabs), [tabs]);
  // La conversation ouverte a toujours son onglet (8 au plus, les plus anciens sortent)
  useEffect(() => {
    const id = state.session?.id;
    if (state.open && id && !tabs.includes(id)) setTabs((t) => [...t, id].slice(-8));
  }, [state.open, state.session?.id]);
  const togglePin = (id: string) => setPins((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const goHome = () => { setState({ ...state, open: false }); setItems([]); };
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t !== id);
    setTabs(rest);
    if (state.open && state.session?.id === id) {
      const next = rest[rest.length - 1];
      if (next) resume(next); else goHome();
    }
  };
  const byId = useMemo(() => new Map((info?.sessions ?? []).map((s) => [s.id, s])), [info]);
  const match = (s: Info["sessions"][number]) => {
    const f = filter.trim().toLowerCase();
    return !f || s.title.toLowerCase().includes(f) || s.workspace.toLowerCase().includes(f);
  };
  const pinned = (info?.sessions ?? []).filter((s) => pins.includes(s.id) && match(s));
  // Sessions regroupées par projet (dossier de travail), le plus récent en premier
  const groups = useMemo(() => {
    const out = new Map<string, Info["sessions"]>();
    for (const s of info?.sessions ?? []) {
      if (pins.includes(s.id) || !match(s)) continue;
      const g = basename(s.workspace);
      out.set(g, [...(out.get(g) ?? []), s]);
    }
    return [...out.entries()];
  }, [info, filter, pins]);
  const convRow = (s: Info["sessions"][number]) => (
    <div key={s.id} class={`conv ${state.open && state.session?.id === s.id ? "on" : ""}`} role="button" tabIndex={0}
      title={`${s.workspace}\nShift-clic : ${pins.includes(s.id) ? "désépingler" : "épingler"}`}
      onClick={(e) => (e.shiftKey ? togglePin(s.id) : resume(s.id))} onKeyDown={(e) => e.key === "Enter" && resume(s.id)}>
      <span class="conv-title">{s.title}</span>
      <span class="conv-time">{ago(s.updated)}</span>
      <button class="icon-btn del" title="Supprimer" onClick={(e) => { e.stopPropagation(); remove(s.id, s.title); }}><span class="ico">{I.trash}</span></button>
    </div>
  );

  const welcome = (
    <div class="welcome">
      <div class="logo"><span class="ico">{I.eclipse}</span></div>
      <h1>{state.open ? "Que voulez-vous faire ?" : "Bonjour"}</h1>
      {state.open ? (
        <p class="muted">Projet <b>{basename(state.session!.workspace)}</b> · {state.mode_label}{state.model ? ` · ${state.model}` : ""}.
          {!state.configured && <> <button class="link" onClick={() => setModal("connections")}>Configurer une connexion</button> pour commencer.</>}</p>
      ) : null}
      {state.open && detected.filter((a) => a.id !== state.mode).length > 0 && (
        <div class={`quick ${state.configured ? "" : "strong"}`}>
          <span>{state.configured ? "Autres agents détectés sur cet ordinateur :" : "Agents détectés sur cet ordinateur : un clic pour les utiliser"}</span>
          <div class="quick-list">
            {detected.filter((a) => a.id !== state.mode).map((a) => (
              <button key={a.id} class="btn" onClick={() => quickConnect(a.id, a.label)}><span class="ico">{I.agent}</span> Utiliser {a.label}</button>
            ))}
          </div>
        </div>
      )}
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
  if (phase !== "ready") {
    return (
      <div class="splash">
        <div class="logo"><span class="ico">{I.eclipse}</span></div>
        {phase === "connecting" ? (
          <>
            <h1>Démarrage du moteur Eclipse…</h1>
            <p class="muted"><span class="spinner" /> {elapsed} s</p>
            {elapsed >= 20 && <p class="muted small">C'est plus long que d'habitude (premier lancement, disque lent ou antivirus qui analyse le moteur). Eclipse attend jusqu'à 60 s.</p>}
          </>
        ) : (
          <>
            <h1>Le moteur Eclipse n'a pas démarré</h1>
            <p class="err">{bootError}</p>
            <div class="row-center">
              <button class="btn primary" disabled={restarting} onClick={isDesktop ? restart : boot}>{restarting ? "Relance…" : isDesktop ? "Relancer le moteur" : "Réessayer"}</button>
              {isDesktop && <button class="btn" onClick={() => openLogs().then((d) => say(`Logs : ${d}`)).catch((e) => say(String(e)))}>Ouvrir les logs</button>}
            </div>
            {!isDesktop && <p class="muted small">Mode navigateur : relancez « eclipse web » dans un terminal pour obtenir une nouvelle adresse.</p>}
          </>
        )}
        {toast && <div class="toast" role="status">{toast}</div>}
      </div>
    );
  }
  return (
    <div class={`app ${sidebar ? "" : "no-sidebar"} ${panel && state.open ? "with-panel" : ""}`}>
      {/* Barre latérale */}
      <nav class="sidebar" aria-label="Conversations">
        <div class="side-top">
          <button class="icon-btn" title="Masquer la barre latérale (Ctrl+B)" onClick={() => setSidebar(false)}><span class="ico">{I.sidebar}</span></button>
          <span class="brand"><span class="ico">{I.eclipse}</span> Eclipse</span>
        </div>
        <div class="side-tabs" role="tablist">
          <button role="tab" aria-selected={sideTab === "sessions"} class={sideTab === "sessions" ? "on" : ""} onClick={() => setSideTab("sessions")}>Sessions</button>
          <button role="tab" aria-selected={sideTab === "projects"} class={sideTab === "projects" ? "on" : ""} onClick={() => setSideTab("projects")}>Projets</button>
        </div>
        {sideTab === "sessions" ? (
          <>
            <div class="side-menu">
              <button class="new side-item" onClick={newDiscussion} disabled={busy} title={`Crée un dossier de travail dans ${info?.discussions_dir ?? "~/Projets/Eclipse"}`}><span class="ico">{I.plus}</span> Nouvelle discussion<kbd class="side-kbd">Ctrl+N</kbd></button>
              <button class="side-item" onClick={goHome} disabled={busy}><span class="ico">{I.folder}</span> Ouvrir un projet…</button>
              <button class={`side-item ${panel === "memory" ? "on" : ""}`} onClick={() => togglePanel("memory")} disabled={!state.open}><span class="ico">{I.brain}</span> Mémoire</button>
              <button class={`side-item ${panel === "files" ? "on" : ""}`} onClick={() => togglePanel("files")} disabled={!state.open}><span class="ico">{I.files}</span> Fichiers</button>
              <button class="side-item" onClick={() => setModal("connections")} disabled={!state.open}><span class="ico">{I.plug}</span> Connexions</button>
            </div>
            <div class="side-search"><span class="ico">{I.search}</span><input placeholder="Rechercher des sessions…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} /></div>
            <div class="side-list">
              <div class="side-sec"><span class="ico">{I.pinned}</span> Épinglées</div>
              {pinned.length > 0 ? pinned.map(convRow) : <p class="side-hint"><span class="ico">{I.pin}</span> Shift-clic sur une conversation pour l'épingler</p>}
              <div class="side-sec"><span class="ico">{I.chat}</span> Sessions</div>
              {groups.map(([g, list]) => (
                <div key={g}>
                  <div class="side-group"><span class="ico">{I.folder}</span> {g}</div>
                  {list.map(convRow)}
                </div>
              ))}
              {groups.length === 0 && hits.length === 0 && <p class="side-hint">Aucune session pour le moment</p>}
              {hits.length > 0 && (
                <div>
                  <div class="side-group"><span class="ico">{I.search}</span> Dans les messages</div>
                  {hits.map((h) => (
                    <div key={`h-${h.id}`} class={`conv hitconv ${state.session?.id === h.id ? "on" : ""}`} onClick={() => resume(h.id)} role="button" tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && resume(h.id)}>
                      <span class="conv-title">{h.title}</span>
                      <span class="conv-snippet">{h.snippet.replace(/^\[\w+\]\s*/, "")}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div class="side-list">
            <div class="side-sec"><span class="ico">{I.folder}</span> Projets récents</div>
            {isDesktop && <button class="side-item" onClick={pickFolder}><span class="ico">{I.plus}</span> Ouvrir un dossier…</button>}
            {(info?.recent_dirs ?? []).map((d) => (
              <button key={d} class={`side-item proj ${state.open && state.session?.workspace === d ? "on" : ""}`} onClick={() => openWorkspace(d)} title={d}>
                <span class="ico">{I.folder}</span><span class="pi-name">{basename(d)}</span>
                <span class="conv-time">{(info?.sessions ?? []).filter((x) => x.workspace === d).length}</span>
              </button>
            ))}
            {(info?.recent_dirs ?? []).length === 0 && <p class="side-hint">Aucun projet ouvert pour le moment</p>}
          </div>
        )}
        <div class="side-bottom">
          <button class="icon-btn" title="Accueil" onClick={goHome}><span class="ico">{I.home}</span></button>
          <span class="spacer" />
          <button class="icon-btn" title="Commandes (Ctrl+K)" onClick={() => setPalette(true)}><span class="ico">{I.palette}</span></button>
          <button class="icon-btn" title="Réglages (Ctrl+,)" onClick={() => setModal("settings")}><span class="ico">{I.settings}</span></button>
          <button class="icon-btn" title="Aide (F1)" onClick={() => setHelp(true)}><span class="ico">{I.info}</span></button>
        </div>
      </nav>

      {/* Zone principale */}
      <main class={`main ${dragOver ? "drag" : ""}`}
        onDragOver={(e) => { if (state.open && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer?.files.length) attach(e.dataTransfer.files); }}>
        <header class="topbar">
          {!sidebar && <button class="icon-btn" title="Afficher la barre latérale (Ctrl+B)" onClick={() => setSidebar(true)}><span class="ico">{I.sidebar}</span></button>}
          <div class="ctabs" role="tablist" aria-label="Conversations ouvertes">
            {tabs.map((id) => {
              const s = byId.get(id) ?? (state.session?.id === id ? { title: state.session.title, workspace: state.session.workspace } : null);
              if (!s) return null;
              const on = state.open && state.session?.id === id;
              return (
                <div key={id} role="tab" aria-selected={on} tabIndex={0} class={`ctab ${on ? "on" : ""}`} title={on ? "Double-clic : renommer" : s.workspace}
                  onClick={() => resume(id)} onDblClick={on ? rename : undefined} onKeyDown={(e) => e.key === "Enter" && resume(id)}>
                  {on && <span class="ctab-dot" />}
                  <span class="ctab-title">{s.title && s.title !== "(sans titre)" ? s.title : "Nouvelle conversation"}</span>
                  <button class="ctab-x" title="Fermer l'onglet" onClick={(e) => { e.stopPropagation(); closeTab(id); }}><span class="ico">{I.close}</span></button>
                </div>
              );
            })}
            <button class="icon-btn small" title="Nouvelle conversation dans ce dossier (même mémoire)" disabled={busy || !state.open} onClick={newConversation}><span class="ico">{I.plus}</span></button>
          </div>
          <span class="spacer" />
          {state.open && (
            <>
              <button class="icon-btn" title="Annuler le dernier échange" disabled={busy} onClick={async () => { const r = await api.undo(); if (r.ok) setItems(fromTranscript(r.items)); else say("Rien à annuler."); }}><span class="ico">{I.undo}</span></button>
              <button class={`icon-btn ${panel === "memory" ? "on" : ""}`} title="Mémoire du dossier" onClick={() => togglePanel("memory")}><span class="ico">{I.brain}</span></button>
              <button class={`icon-btn ${panel === "files" ? "on" : ""}`} title="Fichiers du dossier" onClick={() => togglePanel("files")}><span class="ico">{I.files}</span></button>
              <button class={`icon-btn ${panel === "usage" ? "on" : ""}`} title="Consommation" onClick={() => togglePanel("usage")}><span class="ico">{I.graph}</span></button>
            </>
          )}
        </header>

        {down && (
          <div class="banner" role="alert">
            <span class="ico">{I.warn}</span>
            <span>Le moteur Eclipse ne répond plus.{isDesktop ? "" : " Relancez « eclipse web » dans un terminal si le problème persiste."}</span>
            <span class="spacer" />
            <button class="btn primary" disabled={restarting} onClick={restart}>{restarting ? "Relance…" : isDesktop ? "Relancer le moteur" : "Réessayer"}</button>
          </div>
        )}
        <Thread items={items} pending={pending} busy={busy} empty={welcome} onRetry={state.open ? retry : undefined} showThinking={prefs.showThinking}
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
              {refs.length > 0 && (
                <div class="refs">{refs.map((r) => (
                  <span key={r.path} class={`ref ${r.size === null ? "missing" : r.size > refLimit ? "cut" : ""}`}
                    title={r.size === null ? "Fichier introuvable dans le dossier de travail : il ne sera pas joint" : r.size > refLimit ? `Seuls les ${refLimit.toLocaleString("fr-FR")} premiers caractères seront envoyés` : "Contenu ajouté au message"}>
                    <span class="ico">{I.fileCode}</span>@{r.path}
                    <span class="ref-note">{r.size === null ? "introuvable" : r.size > refLimit ? `tronqué à ${Math.round(refLimit / 1000)} k car. (${fsize(r.size)})` : fsize(r.size)}</span>
                  </span>))}</div>
              )}
              {sug && <Suggest items={sug.items} sel={sug.sel} onPick={pickSuggest} />}
              <div class="composer-bar">
                <label class="icon-btn attach" title="Joindre une image ou un fichier texte (ou glissez-le dans la fenêtre, ou collez une capture)">
                  <span class="ico">{I.plus}</span>
                  <input type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,.txt,.md,.py,.js,.ts,.tsx,.json,.csv,.log,.html,.css,.rs,.kt,.java,.c,.cpp,.h,.go,.sh,.yml,.yaml,.toml,.xml,.sql"
                    onChange={(e) => { const t = e.target as HTMLInputElement; if (t.files) attach(t.files); t.value = ""; }} />
                </label>
                <textarea ref={input} rows={1} value={text} placeholder={state.configured ? "Écrivez à Eclipse…  (@ fichier, / commande)" : "Configurez d'abord une connexion (Connexions)"}
                  onPaste={(e) => { const fs = Array.from(e.clipboardData?.files ?? []); if (fs.length) { e.preventDefault(); attach(fs); } }}
                  onInput={(e) => { const t = e.target as HTMLTextAreaElement; setText(t.value); updateSuggest(t.value, t.selectionStart ?? t.value.length); t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 280)}px`; }}
                  onBlur={() => setTimeout(() => setSug(null), 150)}
                  onFocus={() => { if (state.open) api.files().then((r) => setFiles(r.files)).catch(() => undefined); }}
                  onKeyDown={(e) => {
                    if (sug) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setSug({ ...sug, sel: (sug.sel + 1) % sug.items.length }); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setSug({ ...sug, sel: (sug.sel - 1 + sug.items.length) % sug.items.length }); return; }
                      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); pickSuggest(sug.items[sug.sel]); return; }
                      if (e.key === "Escape") { e.preventDefault(); setSug(null); return; }
                    }
                    const sendKey = prefs.enterSends ? e.key === "Enter" && !e.shiftKey : e.key === "Enter" && (e.ctrlKey || e.metaKey);
                    if (sendKey && !e.isComposing) { e.preventDefault(); send(); }
                    if (e.key === "Escape" && busy) api.interrupt();
                  }} />
                <div class="seg small">
                  {(state.agents ?? ["build", "plan"]).filter((a) => a === "build" || a === "plan" || a === state.session?.agent).map((a) => (
                    <button key={a} class={state.session?.agent === a ? "on" : ""} title={a === "plan" ? "Plan : lecture seule, aucune modification" : "Build : peut modifier et exécuter (avec autorisation)"}
                      onClick={async () => setState(await api.agent(a))}>{a === "build" ? "Build" : a === "plan" ? "Plan" : a}</button>
                  ))}
                </div>
                <div class="model-wrap">
                  <button class="model-btn" onClick={() => setPicker(!picker)} title={`Modèle (${state.mode_label})`}>
                    <span class="mb-prov">{state.mode_label}</span>{(state.model || !(state.is_cli || state.mode === "claude")) && <span class="mb-sep"> · </span>}{state.model || (state.is_cli || state.mode === "claude" ? "" : "choisir un modèle")} <span class="ico small">{I.chevron}</span>
                  </button>
                  {picker && <ModelPicker state={state} onClose={() => setPicker(false)}
                    onPick={async (m) => { setPicker(false); try { setState(await api.model(m)); } catch (e: any) { say(e.message); } }} />}
                </div>
                {busy ? (
                  <button class="send stop" title="Arrêter (Échap)" onClick={() => api.interrupt()}><span class="ico">{I.stop}</span></button>
                ) : (
                  <button class="send" title="Envoyer (Entrée)" disabled={!text.trim() && attachments.length === 0} onClick={send}><span class="ico">{I.arrowUp}</span></button>
                )}
              </div>
            </div>
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
          {panel === "files" && <FilesPanel onOpen={setPreview} refreshKey={refreshKey} onChanges={() => setChangesOpen(true)} />}
          {panel === "usage" && (usage ? <UsageBody u={usage} /> : <p class="muted pad">Chargement…</p>)}
        </aside>
      )}

      <footer class="statusbar">
        <span class={`sb ${online ? "ok" : "warn"}`} title={online ? "Moteur Eclipse local (127.0.0.1)" : "Le moteur ne répond pas"}><span class="ico">{I.server}</span> {online ? "Moteur prêt" : "Moteur déconnecté"}</span>
        {state.open && <span class="chip" title={state.session?.workspace}><span class="ico">{I.folder}</span> {basename(state.session!.workspace)}</span>}
        {state.open && <span class="sb" title="Fournisseur">{state.mode_label}</span>}
        <span class="spacer" />
        {state.open && (
          <>
            <button class={`toggle ${state.auto_edits ? "on" : ""}`} title="Modifications auto : les créations et modifications de fichiers DANS le dossier sont appliquées sans demander. Les commandes vous sont toujours montrées avant exécution."
              onClick={async () => setState(await api.autoEdits(!state.auto_edits))}><span class="knob" /> Modifs auto</button>
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
          </>
        )}
        {isDesktop && <UpdatePill onOpen={() => setModal("update")} />}
        <span class="sb">v{info?.version ?? state.version}</span>
      </footer>

      {modal === "connections" && <ConnectionsModal onClose={() => setModal("")}
        onConnected={(s, msg) => { setState(s); setModal(""); say(msg); if (!s.model && !s.is_cli) setPicker(true); }} />}
      {modal === "settings" && <SettingsModal prefs={prefs} setPrefs={setPrefs} version={info?.version ?? ""} onClose={() => setModal("")} updates={<UpdateSettings />}
        discussionsDir={info?.discussions_dir ?? ""}
        onSaveDir={async (d) => { try { await api.settings({ discussions_dir: d }); refreshInfo(); return null; } catch (e: any) { return e.message; } }} />}
      {modal === "update" && <UpdateDialog onClose={() => setModal("")} />}
      {picker && <div class="click-away" onMouseDown={() => setPicker(false)} />}
      {preview && <FilePreviewModal path={preview} onClose={() => setPreview(null)} />}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {changesOpen && <ChangesModal ask={ask} onClose={() => setChangesOpen(false)}
        onReverted={(n) => { say(`${n} fichier(s) restauré(s).`); setRefreshKey((k) => k + 1); }} />}
      {help && <HelpModal onClose={() => setHelp(false)}
        commands={[...Object.entries(slash).map(([name, v]) => ({ name, desc: v.desc })), ...promptCmds.filter((c) => !(c.name in slash)).map((c) => ({ name: c.name, desc: c.description }))]} />}
      {dialog && <Dialog spec={dialog} onDone={() => setDialog(null)} />}
      {dragOver && <div class="drop-hint"><span class="ico">{I.clip}</span> Déposez pour joindre</div>}
      {toast && <div class="toast" role="status">{toast}</div>}
    </div>
  );
}
