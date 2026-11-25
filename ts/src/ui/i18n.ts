/** Langue de l'interface : français par défaut, anglais d'après LANG ou /language. Les messages des modèles ne sont pas traduits. */
export type Lang = "fr" | "en"

const EN: Record<string, string> = {
  "Choisir un modèle": "Choose a model",
  "Rechercher d'autres modèles…": "Search other models…",
  "Filtrer les modèles…": "Filter models…",
  "RÉCEMMENT UTILISÉS": "RECENTLY USED",
  "API RECOMMANDÉES": "RECOMMENDED APIS",
  "DÉTECTÉS SUR CET ORDINATEUR": "DETECTED ON THIS COMPUTER",
  "RÉSULTATS": "RESULTS",
  "↑↓ choisir · entrée valider · tapez pour rechercher partout": "↑↓ move · enter select · type to search everywhere",
  "échap": "esc",
  "échap retour": "esc back",
  "ancienne version": "previous version",
  "hier": "yesterday",
  "Demandez n'importe quoi…  « Corrige un TODO du projet »": "Ask anything…  \"Fix a TODO in the project\"",
  "Votre message…": "Your message…",
  "aucun modèle — /models": "no model — /models",
  "en cours… échap pour interrompre": "working… esc to interrupt",
  "ctrl+x m modèles   ctrl+p commandes   /help": "ctrl+x m models   ctrl+p commands   /help",
  "ctrl+x : m modèles · n nouvelle discussion · l sessions": "ctrl+x: m models · n new chat · l sessions",
  "Ctrl+C encore une fois pour quitter.": "Ctrl+C again to quit.",
  "Une réponse est en cours (échap pour interrompre).": "A reply is in progress (esc to interrupt).",
  "Aucun modèle choisi : /models": "No model chosen: /models",
  "Commande inconnue": "Unknown command",
  "Mémoire": "Memory",
  "éléments utilisés": "items used",
  "Mémorisé": "Remembered",
  "Sessions": "Sessions",
  "Commandes": "Commands",
  "Thème": "Theme",
  "Langue": "Language",
  "à venir": "coming",
  "prête": "ready",
  "Réflexion": "Thinking",
  "interrompu": "interrupted",
  "Agents détectés": "Detected agents",
  "non installé": "not installed",
  "Clé d'API": "API key",
  "collez ou tapez la clé · échap annuler": "paste or type the key · esc cancel",
  "caractères · entrée enregistrer · échap annuler": "characters · enter save · esc cancel",
  "Vérification de la clé…": "Checking the key…",
  "Modèle": "Model",
}

let lang: Lang = /^en/i.test(process.env.LANG ?? "") ? "en" : "fr"

export function setLang(l: Lang): void {
  lang = l
}
export function getLang(): Lang {
  return lang
}

/** Traduit une chaîne de l'interface (la chaîne française sert de clé). */
export function t(fr: string): string {
  return lang === "en" ? EN[fr] ?? fr : fr
}
