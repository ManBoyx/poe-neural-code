import { expect, test } from "bun:test"
import { speakable, Vad, VAD_DEFAULTS, wav } from "../src/core/voice"

const tone = (ms: number, amp: number) => {
  const n = Math.round((16000 * ms) / 1000)
  const a = new Int16Array(n)
  for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000)) + Math.round((Math.random() - 0.5) * 100)
  return a
}

test("détection de la parole : une phrase après le silence de fin, rien pour un bruit court", () => {
  const vad = new Vad(VAD_DEFAULTS)
  const got: Int16Array[] = []
  for (const part of [tone(600, 50), tone(800, 8000), tone(1200, 50)]) for (let i = 0; i < part.length; i += 800) got.push(...vad.push(part.slice(i, i + 800)))
  expect(got.length).toBe(1)
  expect(got[0].length / 16000).toBeGreaterThan(0.8) // la phrase entière (plus un peu de son avant)
  const vad2 = new Vad(VAD_DEFAULTS)
  const got2: Int16Array[] = []
  for (const part of [tone(600, 50), tone(120, 8000), tone(1200, 50)]) got2.push(...vad2.push(part))
  expect(got2.length).toBe(0) // clic de 120 ms : ignoré
})

test("WAV 16 kHz mono valide ; texte lisible à voix haute", () => {
  const w = wav(new Int16Array(16000))
  expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF")
  expect(w.length).toBe(44 + 32000)
  const s = speakable("## Titre\nVoici **ceci** : `npm test`.\n```ts\nconst x = 1\n```\nVoir https://exemple.fr et [la doc](https://d).")
  expect(s).toBe("Titre Voici ceci : npm test. (bloc de code à l'écran) Voir (lien à l'écran) et la doc.")
  expect(speakable("Phrase. ".repeat(200), 100).endsWith("La suite est à l'écran.")).toBe(true)
})
