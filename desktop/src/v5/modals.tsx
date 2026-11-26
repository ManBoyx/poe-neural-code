/** Fenêtres : choix du modèle, réglages, consommation, projet, autorisation, sous-agent, image en grand. */
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { get, post, type Choice, type EngineState, type ModelsPayload, type Usage } from "./api";
import { usageBars } from "./chart";
import { I } from "./icons";
import { renderMarkdown } from "./markdown";
import { CG_LABEL, type CgAgentId, type Sub } from "./thread";

export function Modal(p: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; icon?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class={`modal ${p.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={p.title}>
        <div class="modal-head">{p.icon && <span class="ic">{p.icon}</span>}<h2>{p.title}</h2><button class="icon-btn ghost" onClick={p.onClose} aria-label="Fermer">{I.close}</button></div>
        <div class="modal-body">{p.children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ choix du modèle
export function ModelPicker({ onClose, onKeys, toast }: { onClose: () => void; onKeys: () => void; toast: (t: string, l?: string) => void }) {
  const [data, setData] = useState<ModelsPayload | null>(null);
  const [q, setQ] = useState("");
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
    for (const pv of data.providers) for (const m of pv.models) if (`${m.id} ${pv.label}`.toLowerCase().includes(f)) out.push({ c: { kind: "api", provider: pv.id, model: m.id }, text: m.id, meta: pv.label + (m.free ? " · gratuit" : "") });
    for (const a of data.agents) if (a.installed && a.label.toLowerCase().includes(f)) out.push({ c: { kind: "agent", provider: a.id }, text: a.label, meta: "agent installé" });
    return out.slice(0, 80);
  }, [data, f]);
  return (
    <Modal title="Choisir un modèle" onClose={onClose} icon={I.sparkle}>
      <label class="search big"><span class="ic">{I.search}</span><input ref={inp} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Rechercher d'autres modèles…" /></label>
      {!data && <p class="dim"><span class="spin" /> Chargement des catalogues…</p>}
      {data && f && (
        <div class="pick-list">{hits.length ? hits.map((h) => <button class="pick" onClick={() => choose(h.c)}><span>{h.text}</span><span class="meta">{h.meta}</span></button>) : <p class="dim">Aucun modèle ne correspond.</p>}</div>
      )}
      {data && !f && (
        <>
          {data.recents.length > 0 && (
            <section class="pick-sec recent"><h4>{I.history} Récemment utilisés</h4>
              <div class="chips">{data.recents.slice(0, 6).map((r) => <button class="chip" onClick={() => choose(r)}>{label(r)}</button>)}</div></section>
          )}
          <section class="pick-sec api"><h4>{I.bolt} API recommandées</h4>
            {data.providers.filter((p) => p.recommended).map((pv) => (
              <div class="prov">
                <div class="prov-head"><b>{pv.label}</b><span class={`key ${pv.key === "ok" ? "ok" : "warn"}`}>{pv.key === "ok" ? `${I.check} clé vérifiée · ${pv.models.length} modèles` : pv.key}</span>
                  {pv.key !== "ok" && <button class="btn small" onClick={onKeys}>{I.key} Ajouter la clé</button>}</div>
                {pv.key === "ok" && <div class="chips">{pv.models.slice(0, 12).map((m) => <button class="chip" onClick={() => choose({ kind: "api", provider: pv.id, model: m.id })}>{m.id}</button>)}
                  {pv.models.length > 12 && <span class="dim">… tapez pour chercher parmi les {pv.models.length}</span>}</div>}
              </div>
            ))}
          </section>
          <section class="pick-sec local"><h4>{I.robot} Détectés sur cet ordinateur</h4>
            <div class="pick-list">
              {data.agents.map((a) => (
                <button class="pick" disabled={!a.installed} onClick={() => choose({ kind: "agent", provider: a.id })} title={a.installed ? "" : a.install ?? "non installé"}>
                  <span>{a.label}</span><span class="meta">{a.installed ? a.version ?? "installé" : "non installé"}</span>
                </button>
              ))}
              {data.providers.filter((p) => p.local).map((pv) => (
                <div class="pick static"><span>{pv.label}</span><span class="meta">{pv.key === "ok" ? `${pv.models.length} modèle(s)` : pv.key}</span></div>
              ))}
            </div>
          </section>
          <section class="pick-sec"><h4>{I.server} Autres fournisseurs</h4>
            <div class="chips">{data.providers.filter((p) => !p.recommended && !p.local).map((pv) => <span class={`chip static ${pv.key === "ok" ? "" : "dim"}`}>{pv.label}{pv.key === "ok" ? ` · ${pv.models.length}` : ""}</span>)}</div>
            <p class="dim small">Ajoutez une clé dans Réglages, puis cherchez le modèle ci-dessus.</p>
          </section>
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ réglages
const PERMS: [string, string][] = [
  ["demander", "Tout confirmer (recommandé)"], ["modifications", "Modifications du projet acceptées, commandes confirmées"], ["lecture", "Lecture seule"],
  ["bypass", "Aucune confirmation, sauf destructif ou hors du projet (mot de passe)"], ["bypass-total", "Aucune confirmation du tout (mot de passe)"],
];

export function Settings({ st, onClose, toast, theme, setTheme, start = "general" }: { st: EngineState; onClose: () => void; toast: (t: string, l?: string) => void; theme: string; setTheme: (t: string) => void; start?: string }) {
  const [tab, setTab] = useState(start);
  const tabs: [string, string, string][] = [["general", "Général", I.tune], ["keys", "Clés d'API", I.key], ["perms", "Permissions", I.shield], ["cg", "/cg", I.agents], ["mcp", "MCP", I.server], ["voice", "Voix", I.mic]];
  return (
    <Modal title="Réglages" onClose={onClose} wide icon={I.cog}>
      <div class="settings">
        <nav class="set-tabs">{tabs.map(([id, l, ic]) => <button class={tab === id ? "on" : ""} onClick={() => setTab(id)}><span class="ic">{ic}</span>{l}</button>)}</nav>
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
      <div class="seg">{[["system", "Système"], ["dark", "Sombre"], ["light", "Clair"]].map(([v, l]) => <button class={theme === v ? "on" : ""} onClick={() => setTheme(v)}>{l}</button>)}</div>
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
      <div class="prov-list">{st.providers.filter((p) => !p.local).map((p) => (
        <button class={`prov-row ${pid === p.id ? "on" : ""}`} onClick={() => setPid(p.id)}>
          <b>{p.label}</b>{p.recommended && <span class="tag">recommandé</span>}<span class={`key ${p.key === "ok" ? "ok" : "warn"}`}>{p.key === "ok" ? `${I.check} ${p.models} modèles` : p.key}</span>
        </button>
      ))}</div>
      <h3>Clé pour {st.providers.find((p) => p.id === pid)?.label}</h3>
      <p class="dim">La clé est vérifiée auprès du fournisseur puis rangée dans le trousseau du système. Elle n'est jamais affichée ni écrite en clair.</p>
      <div class="row">
        <input type="password" autocomplete="off" spellcheck={false} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} placeholder="Collez la clé ici" aria-label="Clé d'API" />
        <button class="btn primary" onClick={save} disabled={busy || !key.trim()}>{busy ? <span class="spin" /> : I.check} Vérifier et enregistrer</button>
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
      <h3>Permissions des modèles et des agents</h3>
      <div class="radio-list">{PERMS.map(([m, l]) => (
        <button class={`radio ${st.perm === m ? "on" : ""} ${m.startsWith("bypass") ? "danger" : ""}`} onClick={() => set(m)} disabled={!!busy}>
          <span class="mark" />{l}{m.startsWith("bypass") && !st.bypassVerified && <span class="dim"> · le mot de passe de l'ordinateur sera demandé une fois</span>}{busy === m && <span class="spin" />}
        </button>
      ))}</div>
      <h3>Sandbox</h3>
      <label class="toggle"><input type="checkbox" checked={st.sandbox} onChange={(e) => post("/api/prefs", { sandbox: (e.target as HTMLInputElement).checked }).catch((x) => toast(x.message, "error"))} />
        <span>Les commandes n'écrivent que dans le projet, /tmp et les caches (bubblewrap). Même coupée, les fichiers d'Eclipse restent en lecture seule.</span></label>
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
      <h3>Claude Code et Codex ensemble</h3>
      <p class="dim">Un seul agent écrit à la fois ; l'autre relit. Chaque agent et chaque sous-agent a son onglet pendant le travail.</p>
      <div class="field"><span>Coordinateur</span><div class="seg">{(["codex", "claude"] as CgAgentId[]).map((a) => <button class={st.cg.lead === a ? "on" : ""} onClick={() => save({ cgLead: a })}>{CG_LABEL[a]}</button>)}</div></div>
      <div class="field"><span>Fonctionnement</span><div class="seg">{[["auto", "Automatique"], ["seul", "Le coordinateur seul"], ["delegue", "Il délègue à l'autre"]].map(([v, l]) => <button class={st.cg.mode === v ? "on" : ""} onClick={() => save({ cgMode: v })}>{l}</button>)}</div></div>
      <label class="toggle"><input type="checkbox" checked={st.cg.review} onChange={(e) => save({ cgReview: (e.target as HTMLInputElement).checked })} /><span>Relecture par l'autre agent</span></label>
      <label class="toggle"><input type="checkbox" checked={st.cg.subagents} onChange={(e) => save({ cgSubagents: (e.target as HTMLInputElement).checked })} /><span>Sous-agents autorisés</span></label>
      {(["claude", "codex"] as CgAgentId[]).map((a) => (
        <div class="agent-cfg">
          <h4>{I.robot} {CG_LABEL[a]}{!st.agents.find((x) => x.id === a)?.installed && <span class="dim"> · non installé</span>}</h4>
          <div class="row3">
            <select value={st.cg.agents[a]?.model ?? ""} onChange={(e) => agentPref(a, "model", (e.target as HTMLSelectElement).value)} aria-label="Modèle">
              <option value="">modèle : par défaut</option>{(models[a] ?? []).map((m) => <option value={m.id}>{m.label ?? m.id}</option>)}
            </select>
            <select value={st.cg.agents[a]?.effort ?? ""} onChange={(e) => agentPref(a, "effort", (e.target as HTMLSelectElement).value)} aria-label="Effort">
              <option value="">effort : par défaut</option>{["low", "medium", "high", "xhigh"].map((x) => <option value={x}>effort : {x}</option>)}
            </select>
            <select value={st.cg.agents[a]?.power ?? ""} onChange={(e) => agentPref(a, "power", (e.target as HTMLSelectElement).value)} aria-label="Pouvoir">
              <option value="">pouvoir : selon les permissions</option><option value="lecture">lecture seule</option><option value="modifications">modifications</option><option value="commandes">modifications et commandes</option>
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
      <p class="dim">Les mêmes que dans Eclipse au terminal : fichier mcp.json des données d'Eclipse, et .eclipse/mcp.json du projet.</p>
      <div class="mcp-list">{st.mcp.length ? st.mcp.map((m) => (
        <div class={`mcp-row ${m.state === "connecté" ? "ok" : m.state === "erreur" ? "bad" : "warn"}`}><b>{m.name}</b><span class="tag">{m.source}</span><span>{m.state}{m.tools ? ` · ${m.tools} outil(s)` : ""}</span>{m.error && <span class="dim">{m.error}</span>}</div>
      )) : <p class="dim">Aucun serveur configuré.</p>}</div>
      <button class="btn" onClick={() => post("/api/mcp/reload").then(load).catch((e) => toast(e.message, "error"))}>{I.refresh} Relancer</button>
      {pending.length > 0 && <h3>À approuver (déclarés par le projet)</h3>}
      {pending.map((x) => (
        <div class="approve">
          <p>Le projet veut lancer ce programme. Lisez toute la configuration avant d'approuver :</p>
          <pre class="out" onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) setRead((r) => ({ ...r, [x.name]: true })); }}
            ref={(el) => { if (el && el.scrollHeight <= el.clientHeight + 4 && !read[x.name]) setRead((r) => ({ ...r, [x.name]: true })); }}>{JSON.stringify(x.config, null, 2)}</pre>
          {x.files.length > 0 && <p class="dim small">Fichiers suivis (l'approbation tombe s'ils changent) : {x.files.join(", ")}</p>}
          <button class="btn primary" disabled={!read[x.name]} onClick={() => approve(x)} title={read[x.name] ? "" : "Faites défiler jusqu'au bout"}>{I.check} Approuver « {x.name} »</button>
        </div>
      ))}
    </>
  );
}

function VoiceSettings({ toast }: { toast: (t: string, l?: string) => void }) {
  const [s, setS] = useState<{ missing: string[] } | null>(null);
  useEffect(() => { get("/api/voice/status").then(setS).catch(() => {}); }, []);
  return (
    <>
      <h3>Voix</h3>
      {!s ? <p class="dim"><span class="spin" /> Vérification…</p> : s.missing.length ? (
        <><p class="warn">Il manque : </p><ul>{s.missing.map((m) => <li>{m}</li>)}</ul><p class="dim">Installation depuis le terminal : <code>Eclipse</code> puis <code>/voice installer</code>.</p></>
      ) : <p class="ok">{I.check} Micro, transcription (whisper.cpp) et voix (piper) prêts, entièrement sur cet ordinateur.</p>}
      <h3>Transcription</h3>
      <div class="seg">{[["base", "Rapide"], ["small", "Précise"]].map(([v, l]) => <button onClick={() => post("/api/prefs", { voiceModel: v }).then(() => toast(`Transcription ${l.toLowerCase()}`)).catch((e) => toast(e.message, "error"))}>{l}</button>)}</div>
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
    <Modal title="Consommation" onClose={onClose} wide icon={I.chart}>
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
    <Modal title="Projet" onClose={onClose} icon={I.folder}>
      <p class="dim">Chaque projet a son dossier dans <code>{st.projectsRoot}</code>. Les modèles et les agents n'écrivent que là, jamais dans Eclipse.</p>
      <div class="row">
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Nom du nouveau projet" onKeyDown={(e) => e.key === "Enter" && open(name)} />
        <button class="btn primary" onClick={() => open(name)} disabled={!name.trim()}>{I.folderPlus} Créer ou ouvrir</button>
      </div>
      {st.projects.length > 0 && <h3>Reprendre un projet</h3>}
      <div class="pick-list">{st.projects.map((p) => <button class="pick" onClick={() => open(p.name)}><span>{p.name}</span><span class="meta">{new Date(p.mtime).toLocaleDateString("fr-FR")}</span></button>)}</div>
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
        <div class="modal-head"><span class="ic">{I.shield}</span><h2>{r.kind === "exec" ? "Autoriser la commande ?" : r.kind === "write" ? "Autoriser la modification ?" : "Autoriser la lecture ?"}</h2></div>
        <div class="modal-body">
          {(r.destructive || r.outside) && <p class="bad">{r.destructive ? "Action destructrice. " : ""}{r.outside ? "Hors du projet." : ""}</p>}
          <p><b>{r.tool}</b> · {r.summary}</p>
          {r.detail && r.detail !== r.summary && <pre class={r.kind === "write" ? "diff" : "out"}>{r.kind === "write" ? r.detail.split("\n").map((l) => <span class={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l + "\n"}</span>) : r.detail}</pre>}
          <div class="row end">
            <button class="btn" onClick={() => onDecide("deny")}>Refuser</button>
            {!r.destructive && !r.outside && <button class="btn" onClick={() => onDecide("session")}>Toujours pour cette session</button>}
            <button class="btn primary" onClick={() => onDecide("once")}>Autoriser une fois</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SubModal({ sub, onClose }: { sub: Sub; onClose: () => void }) {
  return (
    <Modal title={sub.label} onClose={onClose} wide icon={I.robot}>
      <p class="dim">Sous-agent de {CG_LABEL[sub.agent as CgAgentId] ?? sub.agent} · {sub.done ? (sub.ok === false ? "échec" : "terminé") : "travaille"}</p>
      {sub.entries.map((b) => (b.k === "text" ? <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text) }} /> : b.k === "tool" ? <p class="mono">{b.done ? (b.ok === false ? I.alert : I.check) : "…"} {b.name} {b.summary}</p> : null))}
      {sub.report && <><h3>Rapport rendu à l'agent</h3><div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(sub.report) }} /></>}
    </Modal>
  );
}

export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div class="scrim dark" onMouseDown={onClose}>
      <img class="lightbox" src={url} alt="" />
      <a class="btn lb-dl" href={url} target="_blank" rel="noopener noreferrer" onMouseDown={(e) => e.stopPropagation()}>{I.download} Ouvrir l'original</a>
    </div>
  );
}
