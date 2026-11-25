/** Couleurs d'Eclipse : douces sur fond sombre, une couleur fixe par section. Aucune emoji : icônes Nerd Font. */
export const C = {
  text: "#e6e8ee",
  muted: "#9aa3b5",
  dim: "#5f6779",
  accent: "#a78bfa", // violet Eclipse
  recent: "#7dd3fc", // bleu ciel : récemment utilisés
  api: "#c4b5fd", // violet clair : API recommandées
  detected: "#86efac", // vert doux : détectés sur l'ordinateur
  other: "#fcd34d", // ambre : autres fournisseurs
  warn: "#fbbf24",
  error: "#f87171",
  ok: "#4ade80",
  panel: "#141823",
  panelBorder: "#2e3346",
  selBg: "#262b3d",
  userBar: "#a78bfa",
}

export const I = {
  recent: "\u{f02da}", // nf-md-history
  api: "\u{f0318}", // nf-md-key
  detected: "\u{f0379}", // nf-md-monitor
  other: "\u{f0450}", // nf-md-earth
  search: "\u{f0349}", // nf-md-magnify
  ok: "\u{f05e0}", // nf-md-check_circle
  off: "\u{f0766}", // nf-md-circle_outline
  agent: "\u{f06a9}", // nf-md-robot
  model: "\u{f0b79}", // nf-md-chip
  server: "\u{f048b}", // nf-md-server
  warn: "\u{f0026}", // nf-md-alert
  error: "\u{f0159}", // nf-md-close_circle
  think: "\u{f0335}", // nf-md-lightbulb
}

export const MD_STYLES: Record<string, { fg?: string; bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean }> = {
  default: { fg: C.text },
  "markup.heading": { fg: C.accent, bold: true },
  "markup.heading.1": { fg: C.accent, bold: true },
  "markup.heading.2": { fg: C.accent, bold: true },
  "markup.heading.3": { fg: C.api, bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
  "markup.raw": { fg: C.recent },
  "markup.raw.block": { fg: C.text },
  "markup.link": { fg: C.recent, underline: true },
  "markup.link.label": { fg: C.recent, underline: true },
  "markup.link.url": { fg: C.dim },
  "markup.list": { fg: C.accent },
  "markup.quote": { fg: C.muted, italic: true },
}
