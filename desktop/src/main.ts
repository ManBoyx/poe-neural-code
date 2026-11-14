// Eclipse desktop : onglets de terminal (moteur Eclipse ou shell) affichés avec xterm.js, reliés à un pty (Linux) ou ConPTY (Windows).
import { Channel, invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { initUpdates, renderUpdateSettings } from "./updates";

// --- Types partagés avec Rust (src-tauri/src/lib.rs) -----------------------------------------------------------
export interface ShellInfo { id: string; label: string; icon: string }
export interface PlatformInfo {
  os: "linux" | "windows" | "macos" | string;
  version: string;
  shells: ShellInfo[];
  default_shell: string;
  engine: string | null; // chemin du moteur Eclipse, null s'il est introuvable
  portable: boolean;
}
type PtyEvent = { event: "data"; data: string } | { event: "exit"; code: number | null };
type TabKind = { kind: "eclipse" } | { kind: "shell"; shell: string };

// --- Réglages (confort local : perdus sans dommage si le stockage est indisponible) -----------------------------
export interface Settings { fontSize: number; startup: "eclipse" | "shell"; defaultShell: string; copyOnSelect: boolean }
const DEFAULTS: Settings = { fontSize: 13, startup: "eclipse", defaultShell: "", copyOnSelect: false };
function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("eclipse.settings") || "{}") }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(): void {
  try { localStorage.setItem("eclipse.settings", JSON.stringify(settings)); } catch { /* stockage indisponible */ }
}
export const settings = loadSettings();
export let platform: PlatformInfo;
const isWin = () => platform.os === "windows";

// --- Icônes : Nerd Font embarquée (jamais d'emoji) --------------------------------------------------------------
export const ICON: Record<string, string> = {
  eclipse: "\u{F0594}", bash: "", zsh: "", fish: "", sh: "", terminal: "",
  pwsh: "", powershell: "", cmd: "", wsl: "", gitbash: "", close: "",
  settings: "", warn: "", ok: "", info: "", restart: "", download: "", shield: "",
};

const THEME = {
  background: "#0e0e18", foreground: "#e4e4f0", cursor: "#a78bfa", cursorAccent: "#0e0e18", selectionBackground: "#a78bfa55",
  black: "#1b1b2e", red: "#f87171", green: "#4ade80", yellow: "#fbbf24", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e4e4f0",
  brightBlack: "#5c5c7a", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a", brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff",
};

interface Tab {
  key: number; kind: TabKind; title: string; term: Terminal; fit: FitAddon;
  pane: HTMLElement; button: HTMLElement; ptyId: number | null; exited: boolean;
}
const tabs: Tab[] = [];
let active: Tab | null = null;
let nextKey = 1;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function toast(msg: string, ms = 3500): void {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.hidden = true), ms);
}

function shellLabel(id: string): string {
  return platform.shells.find((s) => s.id === id)?.label ?? id;
}

// --- Presse-papiers ---------------------------------------------------------------------------------------------
async function copySelection(tab: Tab): Promise<boolean> {
  const sel = tab.term.getSelection();
  if (!sel) return false;
  await writeText(sel);
  tab.term.clearSelection();
  toast("Copié");
  return true;
}
async function paste(tab: Tab): Promise<void> {
  const text = await readText().catch(() => "");
  if (text) tab.term.paste(text); // xterm gère le collage « bracketed » et normalise les fins de ligne (CRLF -> CR)
}

// --- Raccourcis de l'application (les autres touches vont au programme du terminal) -----------------------------
function appShortcut(e: KeyboardEvent, tab: Tab): boolean {
  if (e.type !== "keydown") return false;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && k === "c") { void copySelection(tab); return true; }
  if (ctrl && e.shiftKey && k === "v") { void paste(tab); return true; }
  // Windows : comme Windows Terminal, Ctrl+C copie s'il y a une sélection (sinon c'est l'interruption), Ctrl+V colle.
  if (isWin() && ctrl && !e.shiftKey && !e.altKey && k === "c" && tab.term.hasSelection()) { void copySelection(tab); return true; }
  if (isWin() && ctrl && !e.shiftKey && !e.altKey && k === "v") { void paste(tab); return true; }
  if (ctrl && e.shiftKey && k === "t") { void openTab({ kind: "shell", shell: settings.defaultShell || platform.default_shell }); return true; }
  if (ctrl && e.shiftKey && k === "e") { void openTab({ kind: "eclipse" }); return true; }
  if (ctrl && e.shiftKey && k === "w") { closeTab(tab); return true; }
  if (ctrl && k === "tab") { cycle(e.shiftKey ? -1 : 1); return true; }
  if (ctrl && !e.shiftKey && (k === "=" || k === "+")) { zoom(1); return true; }
  if (ctrl && !e.shiftKey && k === "-") { zoom(-1); return true; }
  if (ctrl && !e.shiftKey && k === "0") { zoom(0); return true; }
  return false;
}

function zoom(step: number): void {
  setFontSize(step === 0 ? DEFAULTS.fontSize : settings.fontSize + step);
}

function setFontSize(size: number): void {
  settings.fontSize = Math.min(28, Math.max(9, Math.round(size) || DEFAULTS.fontSize));
  saveSettings();
  for (const t of tabs) { t.term.options.fontSize = settings.fontSize; t.fit.fit(); }
}

// --- Onglets ----------------------------------------------------------------------------------------------------
async function openTab(kind: TabKind): Promise<void> {
  if (kind.kind === "eclipse" && !platform.engine) {
    toast("Moteur Eclipse introuvable : ouverture d'un shell à la place.");
    kind = { kind: "shell", shell: settings.defaultShell || platform.default_shell };
  }
  const pane = document.createElement("div");
  pane.className = "pane";
  $("#panes").appendChild(pane);

  const term = new Terminal({
    fontFamily: '"JetBrainsMono NF", monospace', fontSize: settings.fontSize, theme: THEME, cursorBlink: true,
    scrollback: 10000, allowProposedApi: true, macOptionIsMeta: true, rightClickSelectsWord: false,
    windowsPty: platform.os === "windows" ? { backend: "conpty" } : undefined,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon((_e, uri) => { void openUrl(uri); }));
  term.open(pane);
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* rendu DOM par défaut si WebGL est indisponible */ }

  const button = document.createElement("div");
  button.className = "tab";
  button.setAttribute("role", "tab");
  const title = kind.kind === "eclipse" ? "Eclipse" : shellLabel(kind.shell);
  const tab: Tab = { key: nextKey++, kind, title, term, fit, pane, button, ptyId: null, exited: false };
  renderTabButton(tab);
  $("#tabs").appendChild(button);
  tabs.push(tab);

  term.attachCustomKeyEventHandler((e) => !appShortcut(e, tab));
  term.onSelectionChange(() => { if (settings.copyOnSelect && term.hasSelection()) void writeText(term.getSelection()); });
  pane.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void (term.hasSelection() ? copySelection(tab) : paste(tab));
  });
  term.onTitleChange((t) => { if (t) { tab.title = t.slice(0, 40); renderTabButton(tab); } });
  activate(tab);
  await start(tab);
}

async function start(tab: Tab): Promise<void> {
  tab.exited = false;
  tab.pane.querySelector(".ended")?.remove();
  renderTabButton(tab);
  const ch = new Channel<PtyEvent>();
  ch.onmessage = (ev) => {
    if (ev.event === "data") tab.term.write(ev.data);
    else onExit(tab, ev.code);
  };
  tab.fit.fit();
  try {
    tab.ptyId = await invoke<number>("pty_spawn", {
      kind: tab.kind.kind, shell: tab.kind.kind === "shell" ? tab.kind.shell : null,
      cols: tab.term.cols, rows: tab.term.rows, onEvent: ch,
    });
  } catch (err) {
    tab.term.write(`\r\n\x1b[31mImpossible de démarrer : ${err}\x1b[0m\r\n`);
    onExit(tab, null);
    return;
  }
  const id = tab.ptyId;
  tab.term.onData((d) => { if (!tab.exited && tab.ptyId === id) void invoke("pty_write", { id, data: d }); });
  tab.term.onBinary((d) => { if (!tab.exited && tab.ptyId === id) void invoke("pty_write", { id, data: d }); });
  tab.term.onResize(({ cols, rows }) => { if (!tab.exited && tab.ptyId === id) void invoke("pty_resize", { id, cols, rows }); });
}

function onExit(tab: Tab, code: number | null): void {
  tab.exited = true;
  tab.ptyId = null;
  renderTabButton(tab);
  const box = document.createElement("div");
  box.className = "ended";
  box.textContent = `Session terminée${code === null ? "" : ` (code ${code})`}`;
  const again = document.createElement("button");
  again.textContent = "Relancer";
  again.onclick = () => { tab.term.reset(); void start(tab); tab.term.focus(); };
  box.appendChild(again);
  tab.pane.appendChild(box);
}

function renderTabButton(tab: Tab): void {
  const icon = tab.kind.kind === "eclipse" ? ICON.eclipse : ICON[tab.kind.shell] ?? ICON.terminal;
  tab.button.className = "tab" + (tab.exited ? " exited" : "");
  tab.button.setAttribute("aria-selected", String(tab === active));
  tab.button.innerHTML = "";
  const k = document.createElement("span"); k.className = "kind ico"; k.textContent = icon;
  const t = document.createElement("span"); t.className = "title"; t.textContent = tab.title;
  const c = document.createElement("button"); c.className = "close ico"; c.textContent = ICON.close; c.title = "Fermer (Ctrl+Maj+W)";
  c.onclick = (e) => { e.stopPropagation(); closeTab(tab); };
  tab.button.append(k, t, c);
  tab.button.onclick = () => activate(tab);
  tab.button.onauxclick = (e) => { if (e.button === 1) closeTab(tab); };
}

function activate(tab: Tab): void {
  active = tab;
  for (const t of tabs) { t.pane.classList.toggle("active", t === tab); t.button.setAttribute("aria-selected", String(t === tab)); }
  requestAnimationFrame(() => { tab.fit.fit(); tab.term.focus(); });
}

function cycle(dir: number): void {
  if (!active || tabs.length < 2) return;
  const i = tabs.indexOf(active);
  activate(tabs[(i + dir + tabs.length) % tabs.length]);
}

function closeTab(tab: Tab): void {
  if (tab.ptyId !== null) void invoke("pty_kill", { id: tab.ptyId });
  tab.term.dispose();
  tab.pane.remove();
  tab.button.remove();
  tabs.splice(tabs.indexOf(tab), 1);
  if (active === tab) { active = null; if (tabs.length) activate(tabs[tabs.length - 1]); }
  if (!tabs.length) void openTab(startupKind());
}

function startupKind(): TabKind {
  return settings.startup === "eclipse" && platform.engine ? { kind: "eclipse" } : { kind: "shell", shell: settings.defaultShell || platform.default_shell };
}

// --- Menu « + » --------------------------------------------------------------------------------------------------
function buildAddMenu(): void {
  const menu = $("#add-menu");
  menu.innerHTML = "";
  const item = (icon: string, label: string, hint: string, kind: TabKind, disabled = false) => {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.disabled = disabled;
    b.innerHTML = `<span class="ico"></span><span></span><span class="hint"></span>`;
    (b.children[0] as HTMLElement).textContent = icon;
    (b.children[1] as HTMLElement).textContent = label;
    (b.children[2] as HTMLElement).textContent = hint;
    b.onclick = () => { menu.hidden = true; void openTab(kind); };
    menu.appendChild(b);
  };
  item(ICON.eclipse, "Eclipse", platform.engine ? "Ctrl+Maj+E" : "introuvable", { kind: "eclipse" }, !platform.engine);
  menu.appendChild(document.createElement("hr"));
  for (const s of platform.shells) {
    const def = s.id === (settings.defaultShell || platform.default_shell);
    item(ICON[s.icon] ?? ICON.terminal, s.label, def ? "Ctrl+Maj+T" : "", { kind: "shell", shell: s.id });
  }
}

// --- Réglages ----------------------------------------------------------------------------------------------------
function openSettings(): void {
  const d = $("#settings") as HTMLDialogElement;
  const shellOptions = platform.shells.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  d.innerHTML = `
    <header><span class="ico">${ICON.settings}</span> Réglages
      <button class="icon-btn ico" data-close title="Fermer">${ICON.close}</button></header>
    <div class="body">
      <div class="field"><label for="s-start">Onglet au démarrage</label>
        <select id="s-start"><option value="eclipse">Eclipse</option><option value="shell">Shell</option></select></div>
      <div class="field"><label for="s-shell">Shell par défaut</label><select id="s-shell">${shellOptions}</select></div>
      <div class="field"><label for="s-font">Taille du texte</label><input id="s-font" type="number" min="9" max="28"></div>
      <div class="field"><label for="s-cos">Copier à la sélection</label><input id="s-cos" type="checkbox"></div>
      <p class="note">Raccourcis : Ctrl+Maj+C / Ctrl+Maj+V copier-coller${platform.os === "windows" ? " (et Ctrl+C avec sélection / Ctrl+V)" : ""},
        clic droit copie ou colle, Ctrl+Maj+T shell, Ctrl+Maj+E Eclipse, Ctrl+Maj+W fermer, Ctrl+Tab onglet suivant, Ctrl+= / Ctrl+- / Ctrl+0 zoom.</p>
      <div id="update-settings"></div>
      <p class="note">Version ${platform.version}${platform.portable ? " (portable : données à côté de l'exécutable)" : ""}.
        Aucune télémétrie : l'application ne contacte que GitHub pour vérifier les mises à jour, et seulement si vous le laissez activé.</p>
    </div>`;
  const start = d.querySelector("#s-start") as HTMLSelectElement;
  const shell = d.querySelector("#s-shell") as HTMLSelectElement;
  const font = d.querySelector("#s-font") as HTMLInputElement;
  const cos = d.querySelector("#s-cos") as HTMLInputElement;
  start.value = settings.startup; shell.value = settings.defaultShell || platform.default_shell;
  font.value = String(settings.fontSize); cos.checked = settings.copyOnSelect;
  start.onchange = () => { settings.startup = start.value as Settings["startup"]; saveSettings(); };
  shell.onchange = () => { settings.defaultShell = shell.value; saveSettings(); buildAddMenu(); };
  font.onchange = () => setFontSize(Number(font.value));
  cos.onchange = () => { settings.copyOnSelect = cos.checked; saveSettings(); };
  renderUpdateSettings(d.querySelector("#update-settings") as HTMLElement);
  (d.querySelector("[data-close]") as HTMLElement).onclick = () => d.close();
  d.addEventListener("close", () => active?.term.focus(), { once: true });
  d.showModal();
}

// --- Démarrage ---------------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  platform = await invoke<PlatformInfo>("platform_info");
  document.documentElement.dataset.os = platform.os;
  await document.fonts.load(`${settings.fontSize}px "JetBrainsMono NF"`).catch(() => undefined);
  buildAddMenu();
  const addBtn = $("#add-btn"), menu = $("#add-menu");
  addBtn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", () => (menu.hidden = true));
  $("#settings-btn").onclick = openSettings;
  new ResizeObserver(() => active?.fit.fit()).observe($("#panes"));
  // Bloque les raccourcis du navigateur intégré (rechargement, impression, recherche…) ; le terminal les a déjà reçus.
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.key === "F5" || e.key === "F7" || ((e.ctrlKey || e.metaKey) && ["r", "p", "f", "g", "u", "s", "o", "j"].includes(k))) e.preventDefault();
  });
  await openTab(startupKind());
  (window as any).__eclipseReady = true;
  void initUpdates();
}

void main();
