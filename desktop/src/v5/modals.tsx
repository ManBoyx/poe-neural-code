/** Fenêtres : choix du modèle, réglages, consommation, projet, autorisation, sous-agent, image en grand. */
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { get, post, type Choice, type EngineState, type ModelsPayload, type Usage } from "./api";
import { usageBars } from "./chart";
import { I } from "./icons";
import { renderMarkdown } from "./markdown";
import { CG_LABEL, type CgAgentId, type Sub } from "./thread";

export function Modal(p: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class={`modal ${p.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={p.title}>
        <div class="modal-head"><h2>{p.title}</h2><button class="icon-btn press" onClick={p.onClose} aria-label="Fermer"><span class="ic">{I.close}</span></button></div>
        <div class="modal-body">{p.children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ choix du modèle
export function ModelPicker({ onClose, onKeys, toast }: { onClose: () => void; onKeys: () => void; toast: (t: string, l?: string) => void }) {
  const [data, setData] = useState<ModelsPayload | null>(null);
  const [q, setQ] = useState("");
  const [openCat, setOpenCat] = useState<string | null>(null);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { get<ModelsPayload>("/api/models").then(setData).catch((e) => toast(e.message, "error")); inp.current?.focus(); }, []);
  const choose = async (c: Choice) => {
    try { await post("/api/choose", c); onClose(); } catch (e: any) { toast(e.message, "error"); }
  };
  const label = (c: Choice) => (c.kind === "agent" ? data?.agents.find((a) => a.id === c.provider)?.label ?? c.provider : `${c.model} · ${data?.providers.find((p) => p.id === c.provider)?.label ?? c.provider}`);
  const f = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!data || !f) return [];
    const out: { c: Choice; text: string; meta: string }[] = [];
    const cat = (m: { category?: string }) => (data.categories ?? []).find((c) => c.id === m.category)?.label.split(" (")[0] ?? "";
    for (const pv of data.providers) for (const m of pv.models) if (`${m.id} ${pv.label} ${cat(m)}`.toLowerCase().includes(f))
      out.push({ c: { kind: "api", provider: pv.id, model: m.id }, text: m.id, meta: [pv.label, cat(m), m.free ? "gratuit" : ""].filter(Boolean).join(" · ") });
    for (const a of data.agents) if (a.installed && a.label.toLowerCase().includes(f)) out.push({ c: { kind: "agent", provider: a.id }, text: a.label, meta: "agent installé" });
    // n'importe quel bot public de poe.com, par son nom (même absent du catalogue de l'API)
    const raw = q.trim();
    const poe = data.providers.find((p) => p.id === "poe");
    if (poe?.key === "ok" && /^[\w.-]{2,60}$/.test(raw) && !poe.models.some((m) => m.id.toLowerCase() === f))
      out.push({ c: { kind: "api", provider: "poe", model: raw }, text: `Utiliser le bot Poe « ${raw} »`, meta: "tout bot public de poe.com" });
    return out.slice(0, 200);
  }, [data, f]);
  const ok = data?.providers.filter((p) => p.recommended && p.key === "ok") ?? [];
  const missing = data?.providers.filter((p) => p.recommended && p.key !== "ok") ?? [];
  return (
    <Modal title="Choisir un modèle" onClose={onClose}>
      <label class="field big"><span class="ic">{I.search}</span><input ref={inp} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Rechercher d'autres modèles" /></label>
      {!data && <p class="dim"><span class="spin" /> Chargement des catalogues…</p>}
      {data && f && (
        <div class="list">{hits.length ? hits.map((h) => <button class="list-row press" onClick={() => choose(h.c)}><span>{h.text}</span><span class="meta">{h.meta}</span></button>) : <p class="list-row dim">Aucun modèle ne correspond.</p>}</div>
      )}
      {data && !f && (
        <>
          {data.recents.length > 0 && (<>
            <div class="sec-title">Récemment utilisés</div>
            <div class="chips">{data.recents.slice(0, 6).map((r) => <button class="chip press" onClick={() => choose(r)}>{label(r)}</button>)}</div>
          </>)}
          <div class="sec-title">Agents sur cet ordinateur</div>
          <div class="list">
            {data.agents.filter((a) => a.installed).map((a) => <button class="list-row press" onClick={() => choose({ kind: "agent", provider: a.id })}><span class="ic">{I.robot}</span><span>{a.label}</span><span class="meta">{a.version ?? ""}</span></button>)}
            {!data.agents.some((a) => a.installed) && <p class="list-row dim">Aucun agent détecté.</p>}
          </div>
          {ok.map((pv) => (<>
            <div class="sec-title"><b>{pv.label}</b> · {pv.models.length} modèles, rangés par catégorie (tape pour chercher parmi tous)</div>
            {(data.categories ?? [{ id: "", label: "" }]).map((c) => {
              const g = pv.models.filter((m) => !c.id || m.category === c.id);
              if (!g.length) return null;
              const open = openCat === `${pv.id}/${c.id}`;
              return (<>
                {c.label && <div class="cat-title">{c.label} <span class="dim">· {g.length}</span></div>}
                <div class="chips">
                  {(open ? g : g.slice(0, 10)).map((m) => <button class="chip press" onClick={() => choose({ kind: "api", provider: pv.id, model: m.id })}>{m.id}</button>)}
                  {g.length > 10 && <button class="chip more press" onClick={() => setOpenCat(open ? null : `${pv.id}/${c.id}`)}>{open ? "Moins" : `+ ${g.length - 10}`}</button>}
                </div>
              </>);
            })}
          </>))}
          {missing.length > 0 && (<>
            <div class="sec-title">À connecter</div>
            <div class="list">{missing.map((pv) => <button class="list-row press" onClick={onKeys}><span>{pv.label}</span><span class="meta">Ajouter une clé</span></button>)}</div>
          </>)}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ réglages
const PERMS: [string, string][] = [
  ["demander", "Tout confirmer (recommandé)"], ["modifications", "Modifications du projet acceptées, commandes confirmées"], ["lecture", "Lecture seule"],
  ["bypass", "Bypass : tout dans le projet sans confirmation, commandes comprises"], ["bypass-total", "Bypass total : tout sur le PC sans aucune confirmation"],
];

export function Settings({ st, onClose, toast, theme, setTheme, start = "general" }: { st: EngineState; onClose: () => void; toast: (t: string, l?: string) => void; theme: string; setTheme: (t: string) => void; start?: string }) {
  const [tab, setTab] = useState(start);
  const tabs: [string, string, string][] = [["general", "Général", I.tune], ["keys", "Clés d'API", I.key], ["perms", "Sécurité", I.shield], ["cg", "Claude Code + Codex", I.agents], ["mcp", "Serveurs MCP", I.server], ["voice", "Dictée", I.mic]];
  return (
    <Modal title="Réglages" onClose={onClose} wide>
      <div class="settings">
        <nav class="set-tabs">{tabs.map(([id, l, ic]) => <button class={`press ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}><span class="ic">{ic}</span>{l}</button>)}</nav>
        <div class="set-body">
          {tab === "general" && <General theme={theme} setTheme={setTheme} st={st} />}
          {tab === "keys" && <Keys st={st} toast={toast} />}
          {tab === "perms" && <Perms st={st} toast={toast} />}
          {tab === "cg" && <CgSettings st={st} toast={toast} />}
          {tab === "mcp" && <McpSettings st={st} toast={toast} />}
          {tab === "voice" && <VoiceSettings toast={toast} />}
        </div>
      </div>
    </Modal>
  );
}

function General({ theme, setTheme, st }: { theme: string; setTheme: (t: string) => void; st: EngineState }) {
  return (
    <>
      <h3>Apparence</h3>
      <div class="segmented" style={{ maxWidth: "320px" }}>{[["system", "Système"], ["dark", "Sombre"], ["light", "Clair"]].map(([v, l]) => <button class={`press ${theme === v ? "on" : ""}`} onClick={() => setTheme(v)}>{l}</button>)}</div>
      <h3>Projets</h3>
      <p class="dim">Tout travail se fait dans <code>{st.projectsRoot}</code>, un dossier par projet. Aucun modèle ni agent n'écrit dans les fichiers d'Eclipse.</p>
      <h3>Mémoire</h3>
      <p class="dim">{st.memory} élément(s) mémorisé(s) pour ce dossier · partagée avec Eclipse dans le terminal.</p>
    </>
  );
}

function Keys({ st, toast }: { st: EngineState; toast: (t: string, l?: string) => void }) {
  const [pid, setPid] = useState(st.providers.find((p) => p.recommended)?.id ?? st.providers[0]?.id);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/key", { provider: pid, key: key.trim() });
      toast(r.message, r.ok ? "info" : "error");
      if (r.ok) setKey("");
    } catch (e: any) { toast(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <>
      <h3>Fournisseurs</h3>
      <div class="list" style={{ maxHeight: "230px", overflowY: "auto" }}>{st.providers.filter((p) => !p.local).map((p) => (
        <button class="list-row press" onClick={() => setPid(p.id)}>
          <span style={{ fontWeight: pid === p.id ? 600 : 400 }}>{p.label}</span>
          <span class={`meta ${p.key === "ok" ? "ok-text" : ""}`}>{p.key === "ok" ? `Connecté · ${p.models} modèles` : "Non connecté"}</span>
          {pid === p.id && <span class="ic check">{I.check}</span>}
        </button>
      ))}</div>
      <h3>Clé pour {st.providers.find((p) => p.id === pid)?.label}</h3>
      <p class="dim">La clé est vérifiée auprès du fournisseur puis rangée dans le trousseau du système. Elle n'est jamais affichée ni écrite en clair.</p>
      <div class="row">
        <input type="password" autocomplete="off" spellcheck={false} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} placeholder="Collez la clé ici" aria-label="Clé d'API" />
        <button class="btn primary press" onClick={save} disabled={busy || !key.trim()}>{busy ? <span class="spin" /> : null}Vérifier et enregistrer</button>
      </div>
    </>
  );
}

function Perms({ st, toast }: { st: EngineState; toast: (t: string, l?: string) => void }) {
  const [busy, setBusy] = useState("");
  const set = async (mode: string) => {
    setBusy(mode);
    try {
      const r = await post<{ ok: boolean; message?: string }>("/api/permmode", { mode });
      if (!r.ok) toast(r.message ?? "refusé", "error");
    } catch (e: any) { toast(e.message, "error"); } finally { setBusy(""); }
  };
  return (
    <>
      <h3>Ce que les modèles et les agents peuvent faire</h3>
      <div class="list">{PERMS.map(([m, l]) => (
        <button class="list-row press" onClick={() => set(m)} disabled={!!busy}>
          <span>{l}{m.startsWith("bypass") && !st.bypassVerified && <span class="dim small" style={{ display: "block" }}>Le mot de passe de l'ordinateur sera demandé une fois.</span>}</span>
          {busy === m ? <span class="spin check" /> : st.perm === m && <span class="ic check">{I.check}</span>}
        </button>
      ))}</div>
      <h3>Sandbox</h3>
      <label class="toggle"><input type="checkbox" checked={st.sandboxPref ?? st.sandbox} disabled={st.perm.startsWith("bypass")} onChange={(e) => post("/api/prefs", { sandbox: (e.target as HTMLInputElement).checked }).catch((x) => toast(x.message, "error"))} />
        <span>Sandbox des commandes<span class="dim">{st.perm === "bypass" ? "En bypass, les commandes et les agents sont toujours enfermés dans le projet."
          : st.perm === "bypass-total" ? "En bypass total, rien n'est enfermé : tout est autorisé sur le PC."
          : "Les commandes n'écrivent que dans le projet. Même sans sandbox, les fichiers d'Eclipse restent intouchables."}</span></span></label>
    </>
  );
}

function CgSettings({ st, toast }: { st: EngineState; toast: (t: string, l?: string) => void }) {
  const [models, setModels] = useState<Record<string, { id: string; label?: string }[]>>({});
  useEffect(() => { for (const a of ["claude", "codex"]) get(`/api/agent-models?agent=${a}`).then((m) => setModels((x) => ({ ...x, [a]: m }))).catch(() => {}); }, []);
  const save = (p: Record<string, unknown>) => post("/api/prefs", p).catch((e) => toast(e.message, "error"));
  const agentPref = (a: string, k: string, v: string) => save({ agents: { ...st.cg.agents, [a]: { ...(st.cg.agents[a] ?? {}), [k]: v || undefined } } });
  return (
    <>
      <h3>Travailler à deux</h3>
      <p class="dim" style={{ marginTop: 0 }}>Un seul agent écrit à la fois, l'autre relit.</p>
      <div class="kv"><span>Coordinateur</span><div class="segmented">{(["codex", "claude"] as CgAgentId[]).map((a) => <button class={`press ${st.cg.lead === a ? "on" : ""}`} onClick={() => save({ cgLead: a })}>{CG_LABEL[a]}</button>)}</div></div>
      <div class="kv"><span>Répartition</span><div class="segmented">{[["auto", "Automatique"], ["seul", "Le coordinateur seul"], ["delegue", "Il délègue"]].map(([v, l]) => <button class={`press ${st.cg.mode === v ? "on" : ""}`} onClick={() => save({ cgMode: v })}>{l}</button>)}</div></div>
      <label class="toggle"><input type="checkbox" checked={st.cg.review} onChange={(e) => save({ cgReview: (e.target as HTMLInputElement).checked })} /><span>Relecture par l'autre agent</span></label>
      <label class="toggle"><input type="checkbox" checked={st.cg.subagents} onChange={(e) => save({ cgSubagents: (e.target as HTMLInputElement).checked })} /><span>Sous-agents autorisés</span></label>
      {(["claude", "codex"] as CgAgentId[]).map((a) => (
        <div class="agent-cfg">
          <h3>{CG_LABEL[a]}{!st.agents.find((x) => x.id === a)?.installed && " · non installé"}</h3>
          <div class="row3">
            <select value={st.cg.agents[a]?.model ?? ""} onChange={(e) => agentPref(a, "model", (e.target as HTMLSelectElement).value)} aria-label="Modèle">
              <option value="">Modèle par défaut</option>{(models[a] ?? []).map((m) => <option value={m.id}>{m.label ?? m.id}</option>)}
              {st.cg.agents[a]?.model && !(models[a] ?? []).some((m) => m.id === st.cg.agents[a]?.model) && <option value={st.cg.agents[a]!.model}>{st.cg.agents[a]!.model}</option>}
            </select>
            <select value={st.cg.agents[a]?.effort ?? ""} onChange={(e) => agentPref(a, "effort", (e.target as HTMLSelectElement).value)} aria-label="Effort">
              <option value="">Effort par défaut</option>{["low", "medium", "high", "xhigh"].map((x) => <option value={x}>Effort {x}</option>)}
            </select>
            <select value={st.cg.agents[a]?.power ?? ""} onChange={(e) => agentPref(a, "power", (e.target as HTMLSelectElement).value)} aria-label="Pouvoir">
              <option value="">Droits selon la sécurité</option><option value="lecture">Lecture seule</option><option value="modifications">Modifications</option><option value="commandes">Modifications et commandes</option>
            </select>
          </div>
        </div>
      ))}
    </>
  );
}

function McpSettings({ st, toast }: { st: EngineState; toast: (t: string, l?: string) => void }) {
  const [pending, setPending] = useState<{ name: string; config: unknown; fingerprint: string; files: string[] }[]>([]);
  const [read, setRead] = useState<Record<string, boolean>>({});
  const load = () => get("/api/mcp/pending").then(setPending).catch(() => setPending([]));
  useEffect(() => { load(); }, [st.mcp.length]);
  const approve = async (x: { name: string; fingerprint: string }) => {
    try { await post("/api/mcp/approve", x); toast(`Serveur « ${x.name} » approuvé et lancé`); load(); } catch (e: any) { toast(e.message, "error"); load(); }
  };
  return (
    <>
      <h3>Serveurs MCP</h3>
      <p class="dim" style={{ marginTop: 0 }}>Les mêmes que dans Eclipse au terminal.</p>
      <div class="list">{st.mcp.length ? st.mcp.map((m) => (
        <div class="list-row"><span>{m.name}<span class="dim small" style={{ display: "block" }}>{m.source === "projet" ? "Projet" : "Global"}{m.error ? ` · ${m.error}` : ""}</span></span>
          <span class={`meta ${m.state === "connecté" ? "ok-text" : m.state === "erreur" ? "bad-text" : "warn-text"}`}>{m.state}{m.tools ? ` · ${m.tools} outils` : ""}</span></div>
      )) : <p class="list-row dim">Aucun serveur configuré.</p>}</div>
      <div class="row end"><button class="btn press" onClick={() => post("/api/mcp/reload").then(load).catch((e) => toast(e.message, "error"))}>Relancer</button></div>
      {pending.length > 0 && <h3>À approuver (déclarés par le projet)</h3>}
      {pending.map((x) => (
        <div class="approve">
          <p>Le projet veut lancer ce programme. Lisez toute la configuration avant d'approuver :</p>
          <pre class="out" onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) setRead((r) => ({ ...r, [x.fingerprint]: true })); }}
            ref={(el) => { if (el && el.scrollHeight <= el.clientHeight + 4 && !read[x.fingerprint]) setRead((r) => ({ ...r, [x.fingerprint]: true })); }}>{JSON.stringify(x.config, null, 2)}</pre>
          {x.files.length > 0 && <p class="dim small">Fichiers suivis (l'approbation tombe s'ils changent) : {x.files.join(", ")}</p>}
          <button class="btn primary press" disabled={!read[x.fingerprint]} onClick={() => approve(x)} title={read[x.fingerprint] ? "" : "Fais défiler jusqu'au bout"}>Approuver « {x.name} »</button>
        </div>
      ))}
    </>
  );
}

function VoiceSettings({ toast }: { toast: (t: string, l?: string) => void }) {
  const [s, setS] = useState<{ ok: boolean; reason?: string } | null>(null);
  useEffect(() => { get("/api/voice/status").then(setS).catch((e) => toast(e.message, "error")); }, []);
  return (
    <>
      <h3>Dictée</h3>
      <p style={{ marginTop: 0 }}>Appuie sur le micro dans la zone de saisie et parle : ton texte s'écrit tout seul quand tu t'arrêtes. Rien n'est lu à voix haute.</p>
      {!s ? <p class="dim"><span class="spin" /> Vérification…</p> : s.ok
        ? <p class="ok-text">Prête. La transcription est faite par OpenAI (celle de ChatGPT), seulement quand tu dictes.</p>
        : <p class="warn-text">{s.reason}</p>}
    </>
  );
}

// ------------------------------------------------------------------ consommation
export function UsageView({ onClose }: { onClose: () => void }) {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { get<Usage>("/api/usage").then(setU).catch((e) => setErr(e.message)); }, []);
  const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
  return (
    <Modal title="Consommation" onClose={onClose} wide>
      {err && <p class="bad">{err}</p>}
      {!u && !err && <p class="dim"><span class="spin" /> Chargement…</p>}
      {u && (
        <div class="usage">
          <div class="tiles">{u.periods.map((p) => (
            <div class="tile"><span class="lbl">{p.label}</span><b>{nf.format(p.tokens)}</b><span class="dim">tokens · {p.requests} requête(s){p.usd ? ` · ≈ ${nf.format(p.usd)} $` : ""}</span></div>
          ))}{u.poe && <div class="tile accent"><span class="lbl">Solde Poe</span><b>{nf.format(u.poe.points)}</b><span class="dim">points</span></div>}</div>
          <h3>30 derniers jours</h3>
          <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown("```chart\n" + JSON.stringify({ type: "bar", labels: u.daily.map((d) => new Date(d.day * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })), series: [{ name: "tokens", data: u.daily.map((d) => d.tokens) }], unit: "tokens" }) + "\n```") }} />
          <h3>Par modèle (ce mois)</h3>
          <table class="grid-table"><thead><tr><th>Modèle</th><th>Requêtes</th><th>Tokens</th><th>≈ $</th></tr></thead>
            <tbody>{u.byModel.map((m) => <tr><td>{m.model}</td><td>{m.requests}</td><td>{nf.format(m.tokens)}</td><td>{m.usd ? nf.format(m.usd) : "—"}</td></tr>)}</tbody></table>
          {u.envelopes.length > 0 && <><h3>Budgets</h3>{u.envelopes.map((e) => <p>{e.envelope.name} : {nf.format(e.spentTokens)} tokens{e.envelope.tokenLimit ? ` / ${nf.format(e.envelope.tokenLimit)}` : ""}</p>)}</>}
        </div>
      )}
    </Modal>
  );
}
void usageBars;

// ------------------------------------------------------------------ projet
export function ProjectChooser({ st, propose, onClose, onDone, toast }: { st: EngineState; propose?: string; onClose: () => void; onDone: () => void; toast: (t: string, l?: string) => void }) {
  const [name, setName] = useState(propose ?? "");
  const open = async (n: string) => {
    if (!n.trim()) return;
    try { await post("/api/project", { name: n.trim() }); onDone(); } catch (e: any) { toast(e.message, "error"); }
  };
  return (
    <Modal title="Projet" onClose={onClose}>
      <p class="dim" style={{ marginTop: 0 }}>Chaque projet a son dossier dans {st.projectsRoot}. Les modèles et les agents n'écrivent que là.</p>
      <div class="row">
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Nom du nouveau projet" onKeyDown={(e) => e.key === "Enter" && open(name)} />
        <button class="btn primary press" onClick={() => open(name)} disabled={!name.trim()}>Créer ou ouvrir</button>
      </div>
      {st.projects.length > 0 && <h3>Reprendre un projet</h3>}
      <div class="list">{st.projects.map((p) => <button class="list-row press" onClick={() => open(p.name)}><span class="ic">{I.folder}</span><span>{p.name}</span><span class="meta">{new Date(p.mtime).toLocaleDateString("fr-FR")}</span></button>)}</div>
    </Modal>
  );
}

// ------------------------------------------------------------------ autorisation demandée par un modèle ou un agent
export function PermModal({ perm, onDecide }: { perm: { id: number; req: { tool: string; kind: string; summary: string; detail?: string; destructive?: boolean; outside?: boolean } }; onDecide: (d: "once" | "session" | "deny") => void }) {
  const r = perm.req;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onDecide("deny"); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [perm.id]);
  return (
    <div class="scrim">
      <div class={`modal perm ${r.destructive ? "danger" : ""}`} role="alertdialog" aria-modal="true">
        <div class="modal-head"><h2>{r.kind === "exec" ? "Autoriser cette commande ?" : r.kind === "write" ? "Autoriser cette modification ?" : "Autoriser cette lecture ?"}</h2></div>
        <div class="modal-body">
          {(r.destructive || r.outside) && <p class="bad-text">{r.destructive ? "Action destructrice. " : ""}{r.outside ? "Hors du projet." : ""}</p>}
          <p><b>{r.tool}</b> · {r.summary}</p>
          {r.detail && r.detail !== r.summary && <pre class={r.kind === "write" ? "diff" : "out"}>{r.kind === "write" ? r.detail.split("\n").map((l) => <span class={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l + "\n"}</span>) : r.detail}</pre>}
          <div class="row end">
            <button class="btn press" onClick={() => onDecide("deny")}>Refuser</button>
            {!r.destructive && !r.outside && <button class="btn press" onClick={() => onDecide("session")}>Toujours pour cette session</button>}
            <button class="btn primary press" onClick={() => onDecide("once")}>Autoriser une fois</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div class="scrim dark" onMouseDown={onClose}>
      <img class="lightbox" src={url} alt="" />
      {/^https?:/i.test(url) && <a class="btn lb-dl" href={url} target="_blank" rel="noopener noreferrer" onMouseDown={(e) => e.stopPropagation()}>Ouvrir l'original</a>}
    </div>
  );
}
