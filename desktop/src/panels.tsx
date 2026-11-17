// Panneaux et fenêtres : consommation, connexions, sélecteur de modèle, réglages (dont mises à jour).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, isDesktop, openLogs, type AgentInfo, type ApiInfo, type Connections, type LocalServer, type State, type Usage } from "./api";
import { I } from "./icons";

const fmt = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n));
const when = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : "—";
const inDelay = (ts: number | null | undefined, now: number) => {
  if (!ts) return "";
  const s = Math.max(0, ts - now), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 24 ? `dans ${Math.floor(h / 24)} j ${h % 24} h` : `dans ${h} h ${String(m).padStart(2, "0")}`;
};

export function Bar({ value, tone }: { value: number | null; tone?: "time" }) {
  const v = value === null ? 0 : Math.max(0, Math.min(1, value));
  const color = tone === "time" ? "var(--blue)" : v >= 0.9 ? "var(--red)" : v >= 0.7 ? "var(--amber)" : "var(--green)";
  return <div class="bar" role="progressbar" aria-valuenow={Math.round(v * 100)}><div style={{ width: `${v * 100}%`, background: color }} /></div>;
}

export function Modal({ title, icon, onClose, children, wide }: { title: string; icon: string; onClose: () => void; children: preact.ComponentChildren; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus clavier : dans la fenêtre à l'ouverture, rendu à l'élément d'origine à la fermeture
    const previous = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    requestAnimationFrame(() => {
      const el = box.current;
      if (el && !el.contains(document.activeElement)) {
        (el.querySelector<HTMLElement>("[autofocus], input, textarea, select, .modal-body button, button") ?? el).focus();
      }
    });
    return () => { removeEventListener("keydown", k); previous?.focus?.(); };
  }, []);
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} class={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><span class="ico">{icon}</span><h2>{title}</h2><button class="icon-btn" onClick={onClose} title="Fermer"><span class="ico">{I.close}</span></button></header>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

// --- Consommation ---------------------------------------------------------------------------------------------------
export function UsagePanel({ usage, onClose }: { usage: Usage | null; onClose: () => void }) {
  return (
    <aside class="drawer" aria-label="Consommation">
      <header><span class="ico">{I.graph}</span><h2>Consommation</h2><button class="icon-btn" onClick={onClose} title="Fermer"><span class="ico">{I.close}</span></button></header>
      {!usage ? <p class="muted pad">Ouvrez une conversation.</p> : <UsageBody u={usage} />}
    </aside>
  );
}

export function UsageBody({ u }: { u: Usage }) {
  const t = u.totals;
  const tin = (t.tokens_in.measured ?? 0) + (t.tokens_in.estimated ?? 0);
  const tout = (t.tokens_out.measured ?? 0) + (t.tokens_out.estimated ?? 0);
  const estimated = (t.tokens_in.estimated ?? 0) + (t.tokens_out.estimated ?? 0) > 0;
  const pts = Object.entries(t.points).filter(([, v]) => v > 0);
  return (
    <div class="usage">
      <section>
        <h3>Fournisseur</h3>
        <dl><dt>Connexion</dt><dd>{u.mode_label}</dd><dt>Facturation</dt><dd>{u.subscription ? "abonnement (géré par le fournisseur)" : "à l'usage"}</dd></dl>
      </section>
      {u.claude && (
        <section>
          <h3>Abonnement Claude</h3>
          {u.claude.windows.length === 0 && <p class="muted">Les fenêtres d'usage arrivent avec la première réponse.</p>}
          {u.claude.windows.map((w) => {
            const elapsed = w.resets_at && w.seconds ? Math.max(0, Math.min(1, 1 - (w.resets_at - u.now) / w.seconds)) : null;
            return (
              <div class="window" key={w.key}>
                <div class="win-title">Fenêtre {w.name}</div>
                <div class="row"><span>Utilisé</span><Bar value={w.utilization} /><b>{w.utilization === null ? "—" : `${Math.round(w.utilization * 100)} %`}</b></div>
                {elapsed !== null && <div class="row"><span>Écoulé</span><Bar value={elapsed} tone="time" /><b>{Math.round(elapsed * 100)} %</b></div>}
                <div class="row small"><span>Renouvelée</span><span>{inDelay(w.resets_at, u.now)} · {when(w.resets_at)}</span></div>
              </div>
            );
          })}
          <dl><dt>Cache relu</dt><dd>{fmt(u.claude.cache_read_tokens)} tokens</dd><dt>Équivalent API</dt><dd>{u.claude.cost_usd_equiv.toFixed(3)} $ (indicatif)</dd></dl>
        </section>
      )}
      <section>
        <h3>Cette conversation</h3>
        <dl>
          <dt>Requêtes</dt><dd>{t.requests}</dd>
          <dt>Tokens envoyés</dt><dd>{fmt(tin)}</dd>
          <dt>Tokens reçus</dt><dd>{fmt(tout)}</dd>
          {!u.subscription && t.usd > 0 && <><dt>Coût</dt><dd>{t.usd.toFixed(4)} $ (estimé)</dd></>}
          {!u.subscription && pts.map(([k, v]) => <><dt>Points ({k})</dt><dd>{v.toFixed(1)}</dd></>)}
        </dl>
        <p class="legend">{estimated ? "Certaines valeurs sont estimées par Eclipse ; " : ""}mesuré = renvoyé par le fournisseur.</p>
      </section>
      {u.savings && (
        <section>
          <h3>Tokens évités (estimation)</h3>
          <dl>
            <dt>Lectures partielles</dt><dd>{fmt(u.savings.partial_reads)}</dd>
            <dt>Contexte allégé</dt><dd>{fmt(u.savings.context_trim)}</dd>
            <dt>Total estimé</dt><dd><b>{fmt(u.savings.partial_reads + u.savings.context_trim)}</b></dd>
            <dt>Cache de passages</dt><dd>{u.savings.cache_hits} réutilisation(s)</dd>
          </dl>
          <details class="method"><summary>Comment c'est calculé</summary><p>{u.savings.method}</p></details>
        </section>
      )}
      {u.envelopes.length > 0 && (
        <section>
          <h3>{u.subscription ? "Limite Eclipse" : "Budgets"}</h3>
          {u.envelopes.map((e) => {
            const tokens = e.token_limit !== null;
            const used = tokens ? e.spent_tokens : e.spent_points;
            const total = tokens ? e.token_limit : e.total_points;
            return (
              <div class="window" key={e.name}>
                <div class="win-title">{e.name}</div>
                <div class="row"><span>{tokens ? "Tokens" : "Points"}</span><Bar value={total ? used / total : null} /><b>{fmt(used)} / {total ? fmt(total) : "∞"}</b></div>
                <div class="row small"><span>Renouvellement</span><span>{inDelay(e.renews_at, u.now)} · {when(e.renews_at)}</span></div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

// --- Sélecteur de modèle --------------------------------------------------------------------------------------------
const CLAUDE_MODELS = ["opus", "sonnet", "haiku"];

export function ModelPicker({ state, onPick, onClose }: { state: State; onPick: (m: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const list = useMemo(() => {
    const base = state.mode === "claude" ? CLAUDE_MODELS.map((id) => ({ id, free: false, context: null, tools: true, description: "alias Claude Code" }))
      : state.models ?? [];
    const f = q.trim().toLowerCase();
    return base.filter((m) => !f || m.id.toLowerCase().includes(f) || m.description.toLowerCase().includes(f)).slice(0, 200);
  }, [q, state]);
  const free = state.is_cli && state.mode !== "claude";
  return (
    <div class="popover" onMouseDown={(e) => e.stopPropagation()}>
      <input ref={input} class="search" placeholder={free ? "Nom du modèle de l'agent (vide = défaut)" : "Rechercher un modèle…"} value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") { if (free) onPick(q.trim()); else if (list[0]) onPick(list[0].id); }
        }} />
      <div class="pop-list">
        {(state.mode === "claude" || free) && <button class={`pop-item ${!state.model ? "on" : ""}`} onClick={() => onPick("")}>Modèle par défaut</button>}
        {list.map((m) => (
          <button key={m.id} class={`pop-item ${m.id === state.model ? "on" : ""}`} onClick={() => onPick(m.id)} title={m.description}>
            <span class="pi-name">{m.id}</span>
            <span class="pi-meta">{m.free ? <span class="tag green">gratuit</span> : null}{m.context ? `${Math.round(m.context / 1000)} k` : ""}{!m.tools && state.mode !== "claude" ? " · sans outils" : ""}</span>
          </button>
        ))}
        {!free && list.length === 0 && <p class="muted pad">Aucun modèle{state.configured ? "" : " : connexion à configurer"}.</p>}
      </div>
    </div>
  );
}

// --- Connexions : 3 blocs (agents installés · clés d'API · serveurs locaux) --------------------------------------------
export function ConnectionsModal({ onClose, onConnected }: { onClose: () => void; onConnected: (s: State, msg: string) => void }) {
  const [c, setC] = useState<Connections | null>(null);
  const [servers, setServers] = useState<LocalServer[] | null>(null);
  const [askKey, setAskKey] = useState<{ id: string; label: string; replace?: boolean } | null>(null);
  const [pathFor, setPathFor] = useState<AgentInfo | null>(null);
  const [addSrv, setAddSrv] = useState<"" | "local" | "remote">("");
  const [key, setKey] = useState("");
  const [field, setField] = useState("");
  const [field2, setField2] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const load = async (refresh = false) => {
    setError("");
    try {
      const fast = await api.connections({ refresh });
      setC(fast);
      api.connections({ versions: true }).then((full) => setC((cur) => cur ? { ...cur, agents: full.agents } : full)).catch(() => undefined);
    } catch (e: any) { setError(String(e.message)); }
  };
  const probe = () => { setServers(null); api.localServers().then((r) => setServers(r.servers)).catch((e) => setError(String(e.message))); };
  useEffect(() => { load(); probe(); }, []);

  const go = async (id: string, label: string, k?: string) => {
    setBusy(id); setError(""); setInfo("");
    try {
      const r = await api.connect(id, k);
      if (r.need_key) { setAskKey({ id, label }); return; }
      if (!r.ok) { setError(r.message || "connexion refusée"); return; }
      setKey(""); setAskKey(null);
      onConnected(r.state!, r.message || `${label} connecté`);
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };
  const savePath = async (agent: AgentInfo, path: string) => {
    setBusy("path"); setError("");
    try {
      const r = await api.agentPath(agent.agent, path);
      setInfo(r.message); setPathFor(null); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };
  const forget = async (a: ApiInfo) => {
    try { const r = await api.forgetKey(a.provider); setInfo(r.message); await load(); } catch (e: any) { setError(e.message); }
  };
  const addServer = async () => {
    setBusy("add"); setError("");
    try {
      const r = await api.addServer(field2, field);
      setAddSrv(""); setField(""); setField2(""); await load(); probe();
      if (r.key_required) setAskKey({ id: r.id, label: field2 || field }); else setInfo(r.message);
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };
  const back = () => { setAskKey(null); setPathFor(null); setAddSrv(""); setKey(""); setError(""); };

  let body: preact.ComponentChildren;
  if (!c) body = <p class="muted">Chargement…</p>;
  else if (askKey) body = (
    <form class="keyform" onSubmit={(e) => { e.preventDefault(); if (key.trim()) go(askKey.id, askKey.label, key.trim()); }}>
      <p>Clé d'API <b>{askKey.label}</b>. Elle est vérifiée auprès du fournisseur, puis stockée dans {c.storage}. Elle n'est jamais affichée ni écrite en clair.</p>
      <input type="password" autocomplete="off" spellcheck={false} placeholder="Collez votre clé d'API" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} autoFocus />
      {error && <p class="err">{error}</p>}
      <div class="row-end"><button type="button" class="btn" onClick={back}>Retour</button><button class="btn primary" disabled={!key.trim() || !!busy}>{busy ? "Vérification…" : "Se connecter"}</button></div>
    </form>
  );
  else if (pathFor) body = (
    <form class="keyform" onSubmit={(e) => { e.preventDefault(); savePath(pathFor, field); }}>
      <p>Chemin de l'exécutable de <b>{pathFor.label}</b> ({pathFor.binaries.join(" ou ")}). Il est prioritaire sur la détection automatique.</p>
      <input class="text mono" spellcheck={false} placeholder="/home/vous/.local/bin/…" value={field} onInput={(e) => setField((e.target as HTMLInputElement).value)} autoFocus />
      {error && <p class="err">{error}</p>}
      <div class="row-end">
        <button type="button" class="btn" onClick={back}>Retour</button>
        <button type="button" class="btn" onClick={() => savePath(pathFor, "")} disabled={!!busy}>Détection automatique</button>
        <button class="btn primary" disabled={!field.trim() || !!busy}>Enregistrer</button>
      </div>
    </form>
  );
  else if (addSrv) body = (
    <form class="keyform" onSubmit={(e) => { e.preventDefault(); addServer(); }}>
      <p>{addSrv === "local" ? "Serveur compatible OpenAI sur cet ordinateur ou le réseau local (aucune clé pour une adresse locale)."
        : "Fournisseur compatible OpenAI distant : adresse https, la clé vous sera demandée ensuite."}</p>
      <input class="text mono" spellcheck={false} placeholder={addSrv === "local" ? "http://localhost:8080/v1" : "https://exemple.com/v1"} value={field}
        onInput={(e) => setField((e.target as HTMLInputElement).value)} autoFocus />
      <input class="text" spellcheck={false} placeholder="Nom affiché (facultatif)" value={field2} onInput={(e) => setField2((e.target as HTMLInputElement).value)} />
      {error && <p class="err">{error}</p>}
      <div class="row-end"><button type="button" class="btn" onClick={back}>Retour</button><button class="btn primary" disabled={!field.trim() || !!busy}>Ajouter</button></div>
    </form>
  );
  else body = (
    <>
      {error && <p class="err">{error}</p>}
      {info && <p class="ok-msg">{info}</p>}
      <section class="conn-block" aria-label="Agents installés">
        <div class="conn-head">
          <h3><span class="num">1</span> Agents installés sur cet ordinateur</h3>
          <button class="btn small" onClick={() => { setC(null); load(true); }} title="Relit le PATH de votre shell et les dossiers d'installation"><span class="ico">{I.retry}</span> Détecter à nouveau</button>
        </div>
        <p class="muted small">Détection automatique, rien à saisir. L'agent choisi travaille dans le dossier de la conversation ; la mémoire d'Eclipse lui est branchée (par MCP quand c'est vérifié).</p>
        <div class="conn-list">
          {c.agents.map((a) => (
            <div key={a.id} class={`conn-row ${a.installed ? "" : "off"} ${c.current === a.id ? "on" : ""}`} title={a.installed ? a.note : a.reason}>
              <span class="ico">{I.agent}</span>
              <div class="conn-main">
                <span class="conn-name">{a.label}{a.version && <span class="conn-ver"> {a.version}</span>}</span>
                <span class="conn-detail mono">{a.installed ? `${a.path} · via ${a.source}` : `non installé — ${a.reason}`}</span>
                {a.installed && (a.memory === "mcp" ? <span class="conn-tag">mémoire Eclipse par MCP</span> : <span class="conn-tag muted">notes du projet transmises</span>)}
              </div>
              <span class="conn-state">{c.current === a.id ? "actif" : a.installed ? "détecté" : "non installé"}</span>
              <button class="btn small" onClick={() => { setField(a.path ?? ""); setPathFor(a); }}>Chemin…</button>
              <button class="btn small primary" disabled={!a.installed || !!busy || c.current === a.id} onClick={() => go(a.id, a.label)}>{busy === a.id ? "…" : "Utiliser"}</button>
            </div>
          ))}
        </div>
      </section>

      <section class="conn-block" aria-label="Fournisseurs par clé d'API">
        <div class="conn-head"><h3><span class="num">2</span> Fournisseurs par clé d'API</h3>
          <button class="btn small" onClick={() => { setField("https://"); setAddSrv("remote"); }}>Autre fournisseur…</button></div>
        <p class="muted small">Clés stockées dans {c.storage}, jamais en clair. Les variables d'environnement (ex. OPENROUTER_API_KEY) restent prises en compte.</p>
        <div class="conn-list">
          {c.apis.map((a) => (
            <div key={a.id} class={`conn-row ${c.current === a.provider ? "on" : ""}`} title={a.note}>
              <span class="ico">{I.key}</span>
              <div class="conn-main">
                <span class="conn-name">{a.label}</span>
                <span class="conn-detail">{a.has_key ? `clé : ${a.key_source}` : `clé à saisir${a.key_env ? ` (ou variable ${a.key_env})` : ""}`}{a.notes ? ` · ${a.notes}` : ""}</span>
              </div>
              <span class="conn-state">{busy === a.id ? "connexion…" : c.current === a.provider ? "actif" : a.has_key ? "clé enregistrée" : ""}</span>
              {a.key_source === "trousseau" ? <button class="btn small" onClick={() => forget(a)}>Oublier</button> : <span />}
              <button class="btn small" onClick={() => setAskKey({ id: a.id, label: a.label, replace: true })}>{a.has_key ? "Changer la clé" : "Saisir la clé"}</button>
              <button class="btn small primary" disabled={!!busy} onClick={() => go(a.id, a.label)}>Utiliser</button>
            </div>
          ))}
        </div>
      </section>

      <section class="conn-block" aria-label="Serveurs locaux">
        <div class="conn-head"><h3><span class="num">3</span> Serveurs locaux compatibles</h3>
          <span><button class="btn small" onClick={probe}>Tester la connexion</button> <button class="btn small" onClick={() => { setField("http://localhost:"); setAddSrv("local"); }}>Ajouter une URL…</button></span></div>
        <p class="muted small">LM Studio (http://localhost:1234/v1), Ollama (http://localhost:11434/v1) ou tout serveur compatible OpenAI. Détectés s'ils tournent.</p>
        <div class="conn-list">
          {(servers ?? c.locals).map((s) => (
            <div key={s.id} class={`conn-row ${servers && !s.running ? "off" : ""} ${c.current === s.provider ? "on" : ""}`}>
              <span class="ico">{I.server}</span>
              <div class="conn-main">
                <span class="conn-name">{s.label}</span>
                <span class="conn-detail mono">{s.url}</span>
                <span class="conn-detail">{!servers ? "test en cours…" : s.running ? (s.models?.length ? `actif · ${s.models.length} modèle(s) chargé(s) : ${s.models.slice(0, 4).join(", ")}` : "actif · aucun modèle chargé") : s.error}</span>
              </div>
              <span class="conn-state">{c.current === s.provider ? "actif" : servers ? (s.running ? "en marche" : "arrêté") : ""}</span>
              <span />
              <button class="btn small primary" disabled={!!busy || (servers !== null && !s.running)} onClick={() => go(s.id, s.label)}>Utiliser</button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
  return <Modal title="Connexions" icon={I.plug} onClose={onClose} wide>{body}</Modal>;
}

// --- Fenêtre d'information (réponse d'une commande « / ») ---------------------------------------------------------
export function InfoModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <Modal title={title} icon={I.info} onClose={onClose} wide>
      <pre class="info-text">{text}</pre>
    </Modal>
  );
}

// --- Réglages -------------------------------------------------------------------------------------------------------
export interface Prefs { theme: "system" | "dark" | "light"; fontSize: number; enterSends: boolean; showThinking: boolean; showDetails?: boolean }
export const DEFAULT_PREFS: Prefs = { theme: "system", fontSize: 15, enterSends: true, showThinking: true, showDetails: false };
export const EFFORT_LABEL: Record<string, string> = { "défaut": "Défaut du modèle", rapide: "Rapide", normal: "Normal", profond: "Profond" };

export function SettingsModal({ prefs, setPrefs, version, onClose, updates, discussionsDir, onSaveDir, defaultEffort, onSaveEffort }: {
  prefs: Prefs; setPrefs: (p: Prefs) => void; version: string; onClose: () => void; updates: preact.ComponentChildren;
  discussionsDir: string; onSaveDir: (d: string) => Promise<string | null>; defaultEffort: string; onSaveEffort: (lv: string) => Promise<string | null>;
}) {
  const [dir, setDir] = useState(discussionsDir);
  const [dirMsg, setDirMsg] = useState("");
  return (
    <Modal title="Réglages" icon={I.settings} onClose={onClose}>
      <div class="field"><label>Thème</label>
        <div class="seg">{(["system", "dark", "light"] as const).map((t) => (
          <button key={t} class={prefs.theme === t ? "on" : ""} onClick={() => setPrefs({ ...prefs, theme: t })}>{{ system: "Système", dark: "Sombre", light: "Clair" }[t]}</button>
        ))}</div></div>
      <div class="field"><label>Taille du texte</label>
        <input type="range" min={13} max={19} value={prefs.fontSize} onInput={(e) => setPrefs({ ...prefs, fontSize: Number((e.target as HTMLInputElement).value) })} />
        <span>{prefs.fontSize} px</span></div>
      <div class="field"><label>Entrée envoie le message</label>
        <input type="checkbox" checked={prefs.enterSends} onChange={(e) => setPrefs({ ...prefs, enterSends: (e.target as HTMLInputElement).checked })} />
        <span class="muted small">{prefs.enterSends ? "Maj+Entrée pour aller à la ligne" : "Ctrl+Entrée pour envoyer"}</span></div>
      <div class="field"><label>Effort par défaut</label>
        <div class="seg">{Object.entries(EFFORT_LABEL).map(([lv, lab]) => (
          <button key={lv} class={defaultEffort === lv ? "on" : ""} onClick={async () => { const err = await onSaveEffort(lv); setDirMsg(err ?? `Effort par défaut : ${lab}.`); }}>{lab}</button>
        ))}</div>
        <span class="muted small">appliqué quand l'effort n'a pas été choisi pour le modèle (même réglage que le CLI)</span></div>
      <div class="field"><label>Dossier des nouvelles discussions</label>
        <input class="text" value={dir} onInput={(e) => setDir((e.target as HTMLInputElement).value)} spellcheck={false} />
        <button class="btn" onClick={async () => { const err = await onSaveDir(dir); setDirMsg(err ?? "Enregistré."); }}>Enregistrer</button></div>
      {dirMsg && <p class="small muted">{dirMsg}</p>}
      <div class="field"><label>Journaux (logs)</label>
        <button class="btn" onClick={async () => { try { setDirMsg(`Logs : ${await openLogs()}`); } catch (e: any) { setDirMsg(String(e?.message ?? e)); } }}>Ouvrir les logs</button>
        <span class="muted small">moteur, interface et erreurs de démarrage, rotation à 1 Mo</span></div>
      {isDesktop && updates}
      <p class="muted small">Eclipse {version}. Aucune télémétrie : seules vos requêtes aux fournisseurs d'IA et, si elle est activée, la vérification des mises à jour sur GitHub sortent de votre ordinateur.</p>
    </Modal>
  );
}
