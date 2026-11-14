// Panneaux et fenêtres : consommation, connexions, sélecteur de modèle, réglages (dont mises à jour).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, isDesktop, type Connections, type State, type Usage } from "./api";
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
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
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

function UsageBody({ u }: { u: Usage }) {
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

// --- Connexions ----------------------------------------------------------------------------------------------------
export function ConnectionsModal({ onClose, onConnected }: { onClose: () => void; onConnected: (s: State, msg: string) => void }) {
  const [c, setC] = useState<Connections | null>(null);
  const [askKey, setAskKey] = useState<{ id: string; label: string } | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.connections().then(setC).catch((e) => setError(String(e.message))); }, []);

  const go = async (id: string, label: string, k?: string) => {
    setBusy(id); setError("");
    try {
      const r = await api.connect(id, k);
      if (r.need_key) { setAskKey({ id, label }); return; }
      if (!r.ok) { setError(r.message || "connexion refusée"); return; }
      onConnected(r.state!, r.message || `${label} connecté`);
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };

  return (
    <Modal title="Connexions" icon={I.plug} onClose={onClose} wide>
      {!c ? <p class="muted">Chargement…</p> : askKey ? (
        <form class="keyform" onSubmit={(e) => { e.preventDefault(); if (key.trim()) go(askKey.id, askKey.label, key.trim()); }}>
          <p>Clé d'API <b>{askKey.label}</b>. Elle est vérifiée auprès du fournisseur, puis stockée dans {c.storage}. Elle n'est jamais affichée ni écrite en clair.</p>
          <input type="password" autocomplete="off" spellcheck={false} placeholder="Collez votre clé d'API" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} autoFocus />
          {error && <p class="err">{error}</p>}
          <div class="row-end"><button type="button" class="btn" onClick={() => { setAskKey(null); setKey(""); }}>Retour</button><button class="btn primary" disabled={!key.trim() || !!busy}>{busy ? "Vérification…" : "Se connecter"}</button></div>
        </form>
      ) : (
        <>
          {error && <p class="err">{error}</p>}
          <h3>Agents installés sur cet ordinateur</h3>
          <p class="muted small">Utilisent votre abonnement (Claude Code, Codex…) : la consommation est gérée par l'abonnement.</p>
          <div class="conn-grid">
            {c.agents.map((a) => (
              <button key={a.id} class={`conn ${c.current === a.id ? "on" : ""}`} disabled={!a.installed || !!busy} onClick={() => go(a.id, a.label)} title={a.note}>
                <span class="ico">{I.agent}</span><span class="conn-name">{a.label}</span>
                <span class="conn-state">{c.current === a.id ? "actif" : a.installed ? "détecté" : "non installé"}</span>
              </button>
            ))}
          </div>
          <h3>Fournisseurs par clé d'API</h3>
          <div class="conn-grid">
            {c.apis.map((a) => (
              <button key={a.id} class={`conn ${c.current === a.id.slice(4) ? "on" : ""}`} disabled={!!busy} onClick={() => go(a.id, a.label)} title={a.note}>
                <span class="ico">{a.key_required ? I.key : I.plug}</span><span class="conn-name">{a.label}</span>
                <span class="conn-state">{busy === a.id ? "connexion…" : c.current === a.id.slice(4) ? "actif" : !a.key_required ? "local" : a.has_key ? "clé enregistrée" : "clé à saisir"}</span>
              </button>
            ))}
          </div>
          <p class="muted small">Stockage des clés : {c.storage}.</p>
        </>
      )}
    </Modal>
  );
}

// --- Réglages -------------------------------------------------------------------------------------------------------
export interface Prefs { theme: "system" | "dark" | "light"; fontSize: number; enterSends: boolean }
export const DEFAULT_PREFS: Prefs = { theme: "system", fontSize: 15, enterSends: true };

export function SettingsModal({ prefs, setPrefs, version, onClose, updates, discussionsDir, onSaveDir }: {
  prefs: Prefs; setPrefs: (p: Prefs) => void; version: string; onClose: () => void; updates: preact.ComponentChildren;
  discussionsDir: string; onSaveDir: (d: string) => Promise<string | null>;
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
      <div class="field"><label>Dossier des nouvelles discussions</label>
        <input class="text" value={dir} onInput={(e) => setDir((e.target as HTMLInputElement).value)} spellcheck={false} />
        <button class="btn" onClick={async () => { const err = await onSaveDir(dir); setDirMsg(err ?? "Enregistré."); }}>Enregistrer</button></div>
      {dirMsg && <p class="small muted">{dirMsg}</p>}
      {isDesktop && updates}
      <p class="muted small">Eclipse {version}. Aucune télémétrie : seules vos requêtes aux fournisseurs d'IA et, si elle est activée, la vérification des mises à jour sur GitHub sortent de votre ordinateur.</p>
    </Modal>
  );
}
