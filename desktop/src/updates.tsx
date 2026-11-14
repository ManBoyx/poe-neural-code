// Mises à jour (application desktop uniquement) : vérification au démarrage puis à intervalle régulier, canaux stable/bêta,
// journal des changements affiché AVANT l'installation. SHA-256 et signature sont vérifiés côté Rust (updates.rs).
import { useEffect, useState } from "preact/hooks";
import { Modal } from "./panels";
import { I } from "./icons";

interface UpdateInfo { version: string; current: string; date: string | null; notes: string; sha256: string | null; can_install: boolean; reason: string | null; page: string }
type InstallEvent = { event: "progress"; received: number; total: number | null } | { event: "verifying" } | { event: "installing" } | { event: "done" };
interface Prefs { channel: "stable" | "beta"; auto: boolean; hours: number }

const KEY = "eclipse.updates";
function load(): Prefs {
  const d: Prefs = { channel: "stable", auto: true, hours: 6 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return d; }
}
let prefs = load();
let available: UpdateInfo | null = null;
let status = "Pas encore vérifié pendant cette session.";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
function save() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* stockage indisponible */ } }

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export async function checkUpdates(manual = false): Promise<string> {
  try {
    available = await invoke<UpdateInfo | null>("update_check", { channel: prefs.channel });
    const t = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    status = available ? `Version ${available.version} disponible (vérifié à ${t}).` : `Vous avez la dernière version (vérifié à ${t}).`;
  } catch (e) {
    status = `Vérification impossible : ${e}`;
  }
  notify();
  return manual ? status : "";
}

let timer: number | undefined;
export function startUpdates(): void {
  clearInterval(timer);
  if (!prefs.auto) return;
  setTimeout(() => void checkUpdates(), 15_000);
  timer = window.setInterval(() => void checkUpdates(), prefs.hours * 3600_000);
}

function useUpdates() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  return { prefs, available, status };
}

export function UpdateSettings() {
  const u = useUpdates();
  const set = (p: Partial<Prefs>) => { prefs = { ...prefs, ...p }; save(); startUpdates(); notify(); };
  return (
    <div class="section-box">
      <h3>Mises à jour</h3>
      <div class="field"><label>Canal</label>
        <div class="seg"><button class={u.prefs.channel === "stable" ? "on" : ""} onClick={() => { set({ channel: "stable" }); void checkUpdates(); }}>Stable</button>
          <button class={u.prefs.channel === "beta" ? "on" : ""} onClick={() => { set({ channel: "beta" }); void checkUpdates(); }}>Bêta</button></div></div>
      <div class="field"><label>Vérifier automatiquement</label><input type="checkbox" checked={u.prefs.auto} onChange={(e) => set({ auto: (e.target as HTMLInputElement).checked })} />
        <select value={String(u.prefs.hours)} onChange={(e) => set({ hours: Number((e.target as HTMLSelectElement).value) })} disabled={!u.prefs.auto}>
          <option value="1">toutes les heures</option><option value="6">toutes les 6 h</option><option value="24">une fois par jour</option></select></div>
      <div class="field"><label>État</label><span class="small">{u.status}</span><button class="btn" onClick={() => void checkUpdates(true)}>Vérifier maintenant</button></div>
      <p class="muted small">La vérification lit un fichier public sur github.com/ManBoyx/eclipse-releases : GitHub voit votre adresse IP, rien d'autre n'est envoyé.</p>
    </div>
  );
}

export function UpdatePill({ onOpen }: { onOpen: () => void }) {
  const u = useUpdates();
  if (!u.available) return null;
  return <button class="pill" onClick={onOpen}><span class="ico">{I.download}</span> Mise à jour {u.available.version}</button>;
}

export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const u = useUpdates();
  const [step, setStep] = useState("");
  const [progress, setProgress] = useState<{ r: number; t: number | null } | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  if (!u.available) return null;
  const a = u.available;
  const install = async () => {
    setWorking(true); setError(""); setStep("Téléchargement…");
    const { Channel } = await import("@tauri-apps/api/core");
    const ch = new Channel<InstallEvent>();
    ch.onmessage = (ev) => {
      if (ev.event === "progress") { setProgress({ r: ev.received, t: ev.total }); setStep("Téléchargement…"); }
      else if (ev.event === "verifying") setStep("Vérification de l'empreinte SHA-256…");
      else if (ev.event === "installing") setStep("Vérification de la signature et installation…");
      else setStep("Installée. Redémarrage…");
    };
    try { await invoke("update_install", { onEvent: ch }); } catch (e) { setError(String(e)); setWorking(false); }
  };
  return (
    <Modal title={`Eclipse ${a.version}`} icon={I.download} onClose={() => !working && onClose()}>
      <p class="muted">Version installée : {a.current}{a.date ? ` · publiée le ${a.date}` : ""}</p>
      <h3>Journal des changements</h3>
      <div class="changelog">{a.notes || "Aucune note fournie pour cette version."}</div>
      <p class="muted small"><span class="ico">{I.shield}</span> Avant l'installation, Eclipse vérifie l'empreinte SHA-256 du paquet{a.sha256 ? ` (${a.sha256.slice(0, 16)}…)` : ""} puis sa signature numérique : si l'un des contrôles échoue, la mise à jour est refusée. L'application redémarre seule.</p>
      {a.reason && <p class="warnline"><span class="ico">{I.warn}</span> {a.reason}</p>}
      {step && <div><progress max={progress?.t ?? undefined} value={progress?.r ?? undefined} /><p class="small">{step}{progress ? ` ${(progress.r / 1048576).toFixed(1)} Mo${progress.t ? ` / ${(progress.t / 1048576).toFixed(1)} Mo` : ""}` : ""}</p></div>}
      {error && <p class="err">{error}</p>}
      <div class="row-end">
        <button class="btn" disabled={working} onClick={async () => (await import("@tauri-apps/plugin-opener")).openUrl(a.page)}>Page de la version</button>
        <button class="btn" disabled={working} onClick={onClose}>Plus tard</button>
        <button class="btn primary" disabled={!a.can_install || working} onClick={install}>Installer</button>
      </div>
    </Modal>
  );
}
