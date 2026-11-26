/**
 * Appel vocal (/voice) : on parle, l'agent ou le modèle choisi répond à voix haute, puis Eclipse réécoute.
 *
 * Claude Code n'a pas d'appel vocal utilisable depuis un autre programme (son /voice est une dictée dans sa propre
 * fenêtre, via un service interne d'Anthropic). Eclipse fait donc lui-même, en local et gratuitement :
 *  - l'écoute : micro lu en flux (`arecord`, 16 kHz mono), détection de la parole et du silence de fin (énergie) ;
 *  - la transcription : whisper.cpp (modèle base : 2,7 s pour une phrase de 3 s sur ce PC ; small si seul présent) ;
 *  - la voix : piper (voix française fr_FR-siwis), lue avec `aplay` ; repli : espeak-ng (plus robotique).
 * Rien ne part sur Internet pour la voix ; seul le texte transcrit est envoyé au modèle ou à l'agent, comme une saisie.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dataDir } from "./paths"
import { killGroup, runCmd } from "./proc"

export function voiceDir(): string {
  return process.env.ECLIPSE_VOICE_DIR ?? join(dataDir(), "voice")
}

export interface VoiceSetup {
  whisper?: string
  model?: string
  piper?: string
  voice?: string
  espeak?: string
  record?: string
  play?: string
  missing: string[]
}

export function setup(prefer: "base" | "small" = "base"): VoiceSetup {
  const v = voiceDir()
  const has = (p: string) => (existsSync(p) ? p : undefined)
  const s: VoiceSetup = {
    whisper: has(join(v, "src/whisper.cpp/build/bin/whisper-cli")),
    model: prefer === "small" ? has(join(v, "models/ggml-small-q5_1.bin")) ?? has(join(v, "models/ggml-base-q5_1.bin"))
                               : has(join(v, "models/ggml-base-q5_1.bin")) ?? has(join(v, "models/ggml-small-q5_1.bin")),
    piper: has(join(v, "piper/piper")),
    voice: has(join(v, "voices/fr_FR-siwis-medium.onnx")),
    espeak: Bun.which("espeak-ng") ?? undefined,
    // ECLIPSE_VOICE_RECORD / ECLIPSE_VOICE_PLAY : remplacent l'enregistreur et le lecteur (tests sans micro ni haut-parleurs)
    record: process.env.ECLIPSE_VOICE_RECORD ?? Bun.which("arecord") ?? undefined,
    play: process.env.ECLIPSE_VOICE_PLAY ?? Bun.which("aplay") ?? undefined,
    missing: [],
  }
  if (!s.record) s.missing.push("arecord (enregistrement du micro, paquet alsa-utils)")
  if (!s.whisper || !s.model) s.missing.push("whisper.cpp et son modèle (transcription) : /voice installer")
  if (!s.play) s.missing.push("aplay (lecture du son, paquet alsa-utils)")
  if ((!s.piper || !s.voice) && !s.espeak) s.missing.push("piper ou espeak-ng (voix) : /voice installer")
  return s
}

// ------------------------------------------------------------------ détection de la parole (énergie)
export interface VadOptions {
  rate: number
  frameMs: number
  startFactor: number // seuil de parole = bruit de fond × facteur
  minLevel: number // seuil absolu minimal (s16)
  endSilenceMs: number // silence qui termine une phrase
  minSpeechMs: number // en dessous : ignoré (toux, clic)
  maxSpeechMs: number
}

export const VAD_DEFAULTS: VadOptions = { rate: 16000, frameMs: 30, startFactor: 3, minLevel: 600, endSilenceMs: 900, minSpeechMs: 300, maxSpeechMs: 30_000 }

export function rms(samples: Int16Array): number {
  let s = 0
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i]
  return Math.sqrt(s / Math.max(1, samples.length))
}

/** Découpe un flux PCM 16 bits mono en phrases : renvoie chaque phrase terminée (avec un peu de son avant le début). */
export class Vad {
  private floor = 0
  private frames = 0
  private speech: Int16Array[] = []
  private pre: Int16Array[] = []
  private silent = 0
  private voiced = 0
  private buf = new Int16Array(0)
  level = 0 // niveau courant 0..1 (pour l'indicateur à l'écran)
  speaking = false

  constructor(private o: VadOptions = VAD_DEFAULTS) {}

  get frameLen(): number {
    return Math.round((this.o.rate * this.o.frameMs) / 1000)
  }

  /** Donne des échantillons ; renvoie les phrases terminées. */
  push(chunk: Int16Array): Int16Array[] {
    const merged = new Int16Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    const out: Int16Array[] = []
    let i = 0
    const n = this.frameLen
    for (; i + n <= merged.length; i += n) {
      const f = merged.slice(i, i + n)
      const e = rms(f)
      this.level = Math.min(1, e / 6000)
      // bruit de fond : appris sur les 15 premières trames puis suivi lentement pendant les silences
      if (this.frames < 15) this.floor = (this.floor * this.frames + e) / (this.frames + 1)
      this.frames++
      const threshold = Math.max(this.o.minLevel, this.floor * this.o.startFactor)
      if (!this.speaking) {
        this.pre.push(f)
        if (this.pre.length > 10) this.pre.shift()
        if (e > threshold) {
          this.speaking = true
          this.speech = [...this.pre]
          this.voiced = 1
          this.silent = 0
        } else if (this.frames > 15) this.floor = this.floor * 0.98 + e * 0.02
        continue
      }
      this.speech.push(f)
      if (e > threshold) {
        this.voiced++
        this.silent = 0
      } else this.silent++
      const ms = (x: number) => x * this.o.frameMs
      if (ms(this.silent) >= this.o.endSilenceMs || ms(this.speech.length) >= this.o.maxSpeechMs) {
        if (ms(this.voiced) >= this.o.minSpeechMs) {
          const total = this.speech.reduce((s, x) => s + x.length, 0)
          const all = new Int16Array(total)
          let o = 0
          for (const x of this.speech) {
            all.set(x, o)
            o += x.length
          }
          out.push(all)
        }
        this.speaking = false
        this.speech = []
        this.pre = []
        this.voiced = 0
        this.silent = 0
      }
    }
    this.buf = merged.slice(i)
    return out
  }

  reset(): void {
    this.speaking = false
    this.speech = []
    this.pre = []
    this.buf = new Int16Array(0)
  }
}

export function wav(samples: Int16Array, rate = 16000): Uint8Array {
  const data = samples.length * 2
  const b = new ArrayBuffer(44 + data)
  const v = new DataView(b)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, "RIFF")
  v.setUint32(4, 36 + data, true)
  str(8, "WAVE")
  str(12, "fmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, "data")
  v.setUint32(40, data, true)
  new Int16Array(b, 44).set(samples)
  return new Uint8Array(b)
}

// ------------------------------------------------------------------ transcription et voix
export async function transcribe(s: VoiceSetup, samples: Int16Array, lang = "fr"): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (!s.whisper || !s.model) return { ok: false, reason: "whisper.cpp n'est pas installé (/voice installer)" }
  const dir = mkdtempSync(join(tmpdir(), "eclipse-voix-"))
  try {
    const f = join(dir, "phrase.wav")
    writeFileSync(f, wav(samples))
    const r = await runCmd([s.whisper, "-m", s.model, "-f", f, "-l", lang, "-nt", "-np", "-t", "8"], { timeoutMs: 60_000 })
    if (r.code !== 0) return { ok: false, reason: `whisper : ${(r.err || r.out).trim().split("\n").pop()}` }
    const text = r.out.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim()
    return { ok: true, text }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Texte lisible à voix haute : sans Markdown, sans blocs de code ni adresses ; une réponse longue est abrégée. */
export function speakable(md: string, max = 700): string {
  let t = md
    .replace(/```[\s\S]*?```/g, " (bloc de code à l'écran) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "(lien à l'écran)")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~|>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (t.length > max) {
    const cut = t.slice(0, max)
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "))
    t = (end > max / 2 ? cut.slice(0, end + 1) : cut) + " La suite est à l'écran."
  }
  return t
}

/** Lit le texte à voix haute ; renvoie une fonction pour couper la voix. */
export function speak(s: VoiceSetup, text: string, onEnd: () => void): () => void {
  if (!s.play || (!(s.piper && s.voice) && !s.espeak)) {
    onEnd()
    return () => {}
  }
  const tts = s.piper && s.voice ? [s.piper, "--model", s.voice, "--output-raw", "--quiet"] : [s.espeak!, "--stdout", "-v", "fr"]
  const rate = s.piper && s.voice ? "22050" : null
  // piper : PCM brut 22,05 kHz ; espeak-ng : WAV (aplay lit l'en-tête)
  const play = rate ? [s.play, "-q", "-r", rate, "-f", "S16_LE", "-c", "1", "-t", "raw"] : [s.play, "-q"]
  const p1 = Bun.spawn(tts, { stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true })
  const p2 = Bun.spawn(play, { stdin: p1.stdout, stdout: "ignore", stderr: "ignore", detached: true })
  p1.stdin.write(text)
  p1.stdin.end()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    onEnd()
  }
  p2.exited.then(finish)
  return () => {
    killGroup(p1.pid)
    killGroup(p2.pid)
    finish()
  }
}

/** Écoute le micro en continu ; `onUtterance` reçoit chaque phrase terminée. Renvoie une fonction d'arrêt. */
export function listen(s: VoiceSetup, cb: { onUtterance: (pcm: Int16Array) => void; onLevel?: (level: number, speaking: boolean) => void; onError?: (msg: string) => void },
                       vad = new Vad()): { stop: () => void; pause: (on: boolean) => void } {
  if (!s.record) {
    cb.onError?.("arecord absent : impossible d'écouter le micro")
    return { stop: () => {}, pause: () => {} }
  }
  const p = Bun.spawn([s.record, "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"], { stdout: "pipe", stderr: "pipe", detached: true })
  let paused = false
  let stopped = false
  ;(async () => {
    let carry: Uint8Array | null = null
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      if (stopped) break
      let bytes = chunk
      if (carry) {
        const m = new Uint8Array(carry.length + chunk.length)
        m.set(carry)
        m.set(chunk, carry.length)
        bytes = m
        carry = null
      }
      const even = bytes.length - (bytes.length % 2)
      if (even < bytes.length) carry = bytes.slice(even)
      const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even))
      if (paused) {
        vad.reset()
        continue
      }
      for (const u of vad.push(samples)) cb.onUtterance(u)
      cb.onLevel?.(vad.level, vad.speaking)
    }
    if (!stopped) {
      const err = await new Response(p.stderr as ReadableStream).text()
      cb.onError?.(`le micro s'est arrêté${err.trim() ? " : " + err.trim().split("\n")[0] : ""}`)
    }
  })()
  return {
    stop: () => {
      stopped = true
      killGroup(p.pid)
    },
    pause: (on) => (paused = on),
  }
}

/** Installe whisper.cpp, son modèle et piper (sans sudo), en suivant les étapes du script d'installation. */
export async function install(progress: (step: string) => void): Promise<{ ok: boolean; message: string }> {
  const v = voiceDir()
  const step = async (label: string, cmd: string[], timeoutMs = 900_000) => {
    progress(label)
    const r = await runCmd(cmd, { timeoutMs, cwd: v })
    if (r.code !== 0) throw new Error(`${label} : ${(r.err || r.out).trim().split("\n").slice(-2).join(" ")}`)
  }
  try {
    await runCmd(["mkdir", "-p", join(v, "tools"), join(v, "src"), join(v, "models"), join(v, "voices"), join(v, "dl")])
    if (!existsSync(join(v, "tools/bin/cmake"))) {
      await step("cmake (environnement Python dédié)", ["python3", "-m", "venv", join(v, "tools")])
      await step("cmake", [join(v, "tools/bin/pip"), "install", "-q", "cmake==3.31.6"])
    }
    if (!existsSync(join(v, "src/whisper.cpp"))) await step("whisper.cpp v1.9.6", ["git", "clone", "-q", "--depth", "1", "--branch", "v1.9.6", "https://github.com/ggml-org/whisper.cpp", join(v, "src/whisper.cpp")])
    if (!existsSync(join(v, "src/whisper.cpp/build/bin/whisper-cli"))) {
      const cm = join(v, "tools/bin/cmake")
      await step("configuration de whisper.cpp", [cm, "-S", join(v, "src/whisper.cpp"), "-B", join(v, "src/whisper.cpp/build"), "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_SDL2=OFF"])
      await step("compilation de whisper.cpp (quelques minutes)", [cm, "--build", join(v, "src/whisper.cpp/build"), "-j8", "--target", "whisper-cli"])
    }
    if (!existsSync(join(v, "models/ggml-base-q5_1.bin")))
      await step("modèle de transcription (60 Mo)", ["curl", "-fsSL", "-o", join(v, "models/ggml-base-q5_1.bin"), "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"])
    if (!existsSync(join(v, "piper/piper"))) {
      await step("piper (voix)", ["curl", "-fsSL", "-o", join(v, "dl/piper.tar.gz"), "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"])
      await step("piper (extraction)", ["tar", "-xzf", join(v, "dl/piper.tar.gz"), "-C", v])
    }
    for (const f of ["fr_FR-siwis-medium.onnx", "fr_FR-siwis-medium.onnx.json"])
      if (!existsSync(join(v, "voices", f))) await step(`voix française (${f.endsWith("json") ? "réglages" : "63 Mo"})`, ["curl", "-fsSL", "-o", join(v, "voices", f), `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/siwis/medium/${f}`])
    return { ok: true, message: "Voix installée : transcription whisper.cpp (small) et voix française piper." }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
