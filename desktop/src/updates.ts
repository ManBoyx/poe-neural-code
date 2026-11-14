// Mises à jour : vérification au démarrage puis à intervalle régulier, canal stable ou bêta, journal des changements
// affiché AVANT l'installation. Le téléchargement, l'empreinte SHA-256 et la signature sont vérifiés côté Rust
// (src-tauri/src/updates.rs) : l'interface ne peut pas contourner ces contrôles.
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ICON, toast } from "./main";

interface UpdateInfo {
  version: string; current: string; date: string | null; notes: string; sha256: string | null;
  can_install: boolean; reason: string | null; page: string;
}
type InstallEvent =
  | { event: "progress"; received: number; total: number | null }
  | { event: "verifying" } | { event: "installing" } | { event: "done" };

interface UpdatePrefs { channel: "stable" | "beta"; auto: boolean; hours: number }
const PREFS_KEY = "eclipse.updates";
function loadPrefs(): UpdatePrefs {
  const d: UpdatePrefs = { channel: "stable", auto: true, hours: 6 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; } catch { return d; }
}
const prefs = loadPrefs();
function savePrefs(): void { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* indisponible */ } }

let available: UpdateInfo | null = null;
let lastStatus = "Jamais vérifié pendant cette session.";
let timer: number | undefined;
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function check(manual: boolean): Promise<void> {
  try {
    available = await invoke<UpdateInfo | null>("update_check", { channel: prefs.channel });
    const now = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    lastStatus = available ? `Version ${available.version} disponible (vérifié à ${now}).` : `Vous avez la dernière version (vérifié à ${now}).`;
    const btn = $("#update-btn");
    btn.hidden = !available;
    if (available) {
      $("#update-label").textContent = `Mise à jour ${available.version}`;
      if (!manual) toast(`Eclipse ${available.version} est disponible.`);
    } else if (manual) toast("Eclipse est à jour.");
  } catch (err) {
    lastStatus = `Échec de la vérification : ${err}`;
    if (manual) toast(lastStatus, 6000);
  }
  const st = document.querySelector("#upd-status");
  if (st) st.textContent = lastStatus;
}

function schedule(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  if (!prefs.auto) return;
  timer = window.setInterval(() => void check(false), Math.max(1, prefs.hours) * 3600_000);
}

export async function initUpdates(): Promise<void> {
  $("#update-btn").onclick = () => openUpdateDialog();
  schedule();
  if (prefs.auto) setTimeout(() => void check(false), 15_000); // après le démarrage, sans le ralentir
}

export function renderUpdateSettings(el: HTMLElement): void {
  el.innerHTML = `
    <div class="field"><label for="u-channel">Canal de mises à jour</label>
      <select id="u-channel"><option value="stable">Stable</option><option value="beta">Bêta (préversions)</option></select></div>
    <div class="field"><label for="u-auto">Vérifier automatiquement</label><input id="u-auto" type="checkbox"></div>
    <div class="field"><label for="u-hours">Intervalle</label>
      <select id="u-hours"><option value="1">toutes les heures</option><option value="6">toutes les 6 h</option><option value="24">une fois par jour</option></select></div>
    <div class="field"><label>État</label><span><span id="upd-status"></span> <button id="u-now" class="pill">Vérifier maintenant</button></span></div>
    <p class="note">La vérification lit un fichier public sur GitHub (github.com/ManBoyx/eclipse-releases) : GitHub voit votre adresse IP,
      rien d'autre n'est envoyé. Désactivez « Vérifier automatiquement » pour ne jamais contacter GitHub sans action de votre part.</p>`;
  const ch = el.querySelector("#u-channel") as HTMLSelectElement;
  const auto = el.querySelector("#u-auto") as HTMLInputElement;
  const hours = el.querySelector("#u-hours") as HTMLSelectElement;
  ch.value = prefs.channel; auto.checked = prefs.auto; hours.value = String(prefs.hours);
  (el.querySelector("#upd-status") as HTMLElement).textContent = lastStatus;
  ch.onchange = () => { prefs.channel = ch.value as UpdatePrefs["channel"]; savePrefs(); void check(true); };
  auto.onchange = () => { prefs.auto = auto.checked; savePrefs(); schedule(); };
  hours.onchange = () => { prefs.hours = Number(hours.value); savePrefs(); schedule(); };
  (el.querySelector("#u-now") as HTMLElement).onclick = () => void check(true);
}

function openUpdateDialog(): void {
  if (!available) return;
  const u = available;
  const d = $("#update-dialog") as HTMLDialogElement;
  d.innerHTML = `
    <header><span class="ico">${ICON.download}</span> Eclipse ${esc(u.version)} <span class="note" style="margin:0 0 0 8px">(installée : ${esc(u.current)}${u.date ? ` · publiée le ${esc(u.date)}` : ""})</span>
      <button class="icon-btn ico" data-close title="Fermer">${ICON.close}</button></header>
    <div class="body">
      <p><strong>Journal des changements</strong></p>
      <div class="changelog">${esc(u.notes || "Aucune note fournie pour cette version.")}</div>
      <p class="note"><span class="ico">${ICON.shield}</span> Avant l'installation, Eclipse vérifie l'empreinte SHA-256 du paquet
        ${u.sha256 ? `(<code>${esc(u.sha256.slice(0, 16))}…</code>)` : ""} puis sa signature numérique. Si l'un des deux contrôles échoue, la mise à jour est refusée.
        Les onglets ouverts seront fermés ; l'application redémarre seule.
        ${document.documentElement.dataset.os === "linux" ? "Pour un paquet .deb ou .rpm, votre mot de passe administrateur sera demandé." : ""}</p>
      ${u.reason ? `<p class="status-warn"><span class="ico">${ICON.warn}</span> ${esc(u.reason)}</p>` : ""}
      <div id="upd-progress" hidden><progress id="upd-bar"></progress><p id="upd-step" class="note"></p></div>
    </div>
    <footer>
      <button data-page>Voir la page de la version</button>
      <button data-close>Plus tard</button>
      <button class="primary" data-install ${u.can_install ? "" : "disabled"}>Installer</button>
    </footer>`;
  d.querySelectorAll("[data-close]").forEach((b) => ((b as HTMLElement).onclick = () => d.close()));
  (d.querySelector("[data-page]") as HTMLElement).onclick = () => void openUrl(u.page);
  (d.querySelector("[data-install]") as HTMLButtonElement).onclick = () => void install(d);
  d.showModal();
}

async function install(d: HTMLDialogElement): Promise<void> {
  const box = d.querySelector("#upd-progress") as HTMLElement;
  const bar = d.querySelector("#upd-bar") as HTMLProgressElement;
  const step = d.querySelector("#upd-step") as HTMLElement;
  d.querySelectorAll("footer button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
  box.hidden = false;
  step.textContent = "Téléchargement…";
  const ch = new Channel<InstallEvent>();
  ch.onmessage = (ev) => {
    if (ev.event === "progress") {
      if (ev.total) { bar.max = ev.total; bar.value = ev.received; }
      step.textContent = `Téléchargement… ${(ev.received / 1048576).toFixed(1)} Mo${ev.total ? ` / ${(ev.total / 1048576).toFixed(1)} Mo` : ""}`;
    } else if (ev.event === "verifying") step.textContent = "Vérification de l'empreinte SHA-256…";
    else if (ev.event === "installing") step.textContent = "Vérification de la signature et installation…";
    else step.textContent = "Installée. Redémarrage…";
  };
  try {
    await invoke("update_install", { onEvent: ch });
  } catch (err) {
    step.className = "status-err";
    step.textContent = `${err}`;
    (d.querySelector("[data-close]") as HTMLButtonElement).disabled = false;
    d.querySelectorAll("[data-close]").forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
}
