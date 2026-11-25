/** Effort rapide / normal / profond, traduit vers les valeurs réelles du modèle (même logique que la version Python). */
export const LEVELS = ["rapide", "normal", "profond"] as const
export type Level = (typeof LEVELS)[number]
const ALIASES: Record<string, Level> = { rapide: "rapide", fast: "rapide", low: "rapide", normal: "normal", medium: "normal", profond: "profond", deep: "profond", high: "profond" }
const PREF: Record<Level, string[]> = { rapide: ["low", "minimal"], normal: ["medium"], profond: ["high"] }

export function isLevel(v: string): v is Level {
  return v in ALIASES && LEVELS.includes(ALIASES[v])
}

/** Valeur à envoyer pour ce niveau ; `undefined` si le modèle n'a pas de réglage d'effort. */
export function levelValue(choices: string[] | undefined, value: string): string | undefined {
  if (!choices?.length) return undefined
  if (choices.includes(value)) return value
  const lv = ALIASES[value.toLowerCase()]
  if (!lv) return undefined
  for (const c of PREF[lv]) if (choices.includes(c)) return c
  const real = choices.filter((c) => !["none", "off", "auto"].includes(c))
  if (!real.length) return undefined
  return lv === "rapide" ? real[0] : lv === "profond" ? real[real.length - 1] : real[Math.floor((real.length - 1) / 2)]
}
