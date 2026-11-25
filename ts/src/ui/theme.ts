/**
 * Thèmes et icônes. Couleurs douces sur fond sombre, une couleur fixe par section ; aucun sens porté par la couleur
 * seule (chaque état a aussi un mot ou une icône). `NO_COLOR` donne le thème sans couleur ; un terminal sans police
 * Nerd Font (console Linux, ou réglage) reçoit des icônes en texte simple. Aucune emoji.
 */
export type ThemeName = "eclipse" | "contraste" | "clair" | "sans-couleur"

type Palette = Record<"text" | "muted" | "dim" | "accent" | "recent" | "api" | "detected" | "other" | "warn" | "error" | "ok" | "panel" | "panelBorder" | "selBg" | "userBar", string>

const PALETTES: Record<ThemeName, Palette> = {
  eclipse: {
    text: "#e6e8ee", muted: "#9aa3b5", dim: "#5f6779", accent: "#a78bfa", recent: "#7dd3fc", api: "#c4b5fd", detected: "#86efac",
    other: "#fcd34d", warn: "#fbbf24", error: "#f87171", ok: "#4ade80", panel: "#141823", panelBorder: "#2e3346", selBg: "#262b3d", userBar: "#a78bfa",
  },
  contraste: {
    text: "#ffffff", muted: "#e0e0e0", dim: "#bdbdbd", accent: "#ffd54f", recent: "#80d8ff", api: "#ffd54f", detected: "#69f0ae",
    other: "#ffab40", warn: "#ffea00", error: "#ff5252", ok: "#69f0ae", panel: "#000000", panelBorder: "#ffffff", selBg: "#3d3d00", userBar: "#ffd54f",
  },
  clair: {
    text: "#1f2330", muted: "#4b5263", dim: "#7a8194", accent: "#6d28d9", recent: "#0369a1", api: "#6d28d9", detected: "#15803d",
    other: "#b45309", warn: "#b45309", error: "#b91c1c", ok: "#15803d", panel: "#f3f4f8", panelBorder: "#c9cdd8", selBg: "#e0d9fb", userBar: "#6d28d9",
  },
  // couleur par défaut du terminal partout : le texte, les mots et les icônes portent le sens
  "sans-couleur": Object.fromEntries(
    ["text", "muted", "dim", "accent", "recent", "api", "detected", "other", "warn", "error", "ok", "panel", "panelBorder", "selBg", "userBar"].map((k) => [k, undefined]),
  ) as unknown as Palette,
}

export const THEME_LABEL: Record<ThemeName, string> = {
  eclipse: "Eclipse (sombre, couleurs douces)", contraste: "Contraste élevé", clair: "Clair", "sans-couleur": "Sans couleur (NO_COLOR)",
}

export const C: Palette = { ...PALETTES.eclipse }
export let themeName: ThemeName = "eclipse"

export function setTheme(name: ThemeName): void {
  themeName = name
  Object.assign(C, PALETTES[name])
}


const NERD = {
  recent: "\u{f02da}", api: "\u{f0318}", detected: "\u{f0379}", other: "\u{f0450}", search: "\u{f0349}", ok: "\u{f05e0}", off: "\u{f0766}",
  agent: "\u{f06a9}", model: "\u{f0b79}", server: "\u{f048b}", warn: "\u{f0026}", error: "\u{f0159}", think: "\u{f0335}", memory: "\u{f035b}",
  user: "\u{f0004}", soon: "\u{f0954}",
}
const ASCII: typeof NERD = {
  recent: "*", api: "#", detected: ">", other: "+", search: "?", ok: "[ok]", off: "[ ]", agent: "@", model: "~", server: "=", warn: "[!]",
  error: "[x]", think: "...", memory: "[m]", user: ">", soon: "(bientôt)",
}
export const I: typeof NERD = { ...NERD }
export let iconSet: "nerd" | "texte" = "nerd"
export function setIcons(kind: "nerd" | "texte"): void {
  iconSet = kind
  Object.assign(I, kind === "nerd" ? NERD : ASCII)
}

/** Réglages initiaux d'après l'environnement : NO_COLOR, console Linux sans police d'icônes. */
export function autoDetect(saved?: { theme?: ThemeName; icons?: "nerd" | "texte" }): void {
  if (process.env.NO_COLOR) setTheme("sans-couleur")
  else if (saved?.theme && PALETTES[saved.theme]) setTheme(saved.theme)
  if (saved?.icons) setIcons(saved.icons)
  else if (process.env.TERM === "linux" || process.env.ECLIPSE_ICONS === "texte") setIcons("texte")
}

export function mdStyles(): Record<string, { fg?: string; bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean }> {
  const f = (c: string | undefined) => (c ? { fg: c } : {})
  return {
    default: f(C.text),
    "markup.heading": { ...f(C.accent), bold: true },
    "markup.heading.1": { ...f(C.accent), bold: true },
    "markup.heading.2": { ...f(C.accent), bold: true },
    "markup.heading.3": { ...f(C.api), bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { dim: true },
    "markup.raw": f(C.recent),
    "markup.raw.block": f(C.text),
    "markup.link": { ...f(C.recent), underline: true },
    "markup.link.label": { ...f(C.recent), underline: true },
    "markup.link.url": f(C.dim),
    "markup.list": f(C.accent),
    "markup.quote": { ...f(C.muted), italic: true },
  }
}
