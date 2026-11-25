import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENTS, detect, locate } from "../src/core/detect"
import { parsePoe, PROVIDERS } from "../src/core/providers"
import { getKey, setRunner, run } from "../src/core/secrets"
import { choose, load, save } from "../src/core/store"
import { streamChat } from "../src/core/chat"

let dir: string
const env0 = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-test-"))
  process.env.PNC_HOME = join(dir, "data")
  process.env.ECLIPSE_AGENT_SCAN = "path"
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  process.env = { ...env0 }
  setRunner(run)
})

function fakeExe(d: string, name: string, script = "#!/bin/sh\necho " + name + " 1.2.3\n") {
  mkdirSync(d, { recursive: true })
  const p = join(d, name)
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return p
}

describe("catalogue Poe", () => {
  test("garde les modèles sans supported_endpoints et ceux qui sortent texte + image", () => {
    const ms = parsePoe([
      { id: "claude-haiku-5.5", architecture: { output_modalities: ["text"] }, supported_endpoints: [], supported_features: ["tools"] },
      { id: "gpt-5.4", architecture: { output_modalities: ["text", "image"] }, supported_endpoints: ["/v1/chat/completions"], supported_features: ["tools"] },
      { id: "gemini-3.5-flash-lite", architecture: { output_modalities: ["text"] }, supported_features: [] },
      { id: "nano-banana", architecture: { output_modalities: ["image"] } },
      { id: "m-effort", parameters: [{ name: "reasoning_effort", schema: { enum: ["low", "high"] } }], pricing: { prompt: "0.000001", completion: "0.000003" } },
    ])
    expect(ms.map((m) => m.id)).toEqual(["claude-haiku-5.5", "gpt-5.4", "gemini-3.5-flash-lite", "m-effort"])
    expect(ms.find((m) => m.id === "gemini-3.5-flash-lite")!.tools).toBe(false)
    expect(ms.find((m) => m.id === "m-effort")!.effort).toEqual(["low", "high"])
    expect(ms.find((m) => m.id === "m-effort")!.priceIn).toBeCloseTo(1)
  })
  test("aucun fournisseur n'est imposé, Poe est recommandé", () => {
    expect(PROVIDERS.filter((p) => p.recommended).map((p) => p.id)).toEqual(["poe"])
    expect(load().current).toBeUndefined()
  })
})

describe("trousseau", () => {
  test("variable d'environnement prioritaire", async () => {
    process.env.POE_API_KEY = "cle-de-test"
    const r = await getKey("poe", "POE_API_KEY")
    expect(r.ok && r.source).toBe("variable POE_API_KEY")
  })
  test("clé absente, trousseau verrouillé et erreur sont distingués", async () => {
    if (process.platform !== "linux" || !Bun.which("secret-tool")) return
    delete process.env.POE_API_KEY
    setRunner(async () => ({ code: 1, out: "", err: "", timedOut: false }))
    expect(await getKey("poe", "POE_API_KEY")).toEqual({ ok: false, missing: true, reason: "aucune clé enregistrée" })
    setRunner(async () => ({ code: null, out: "", err: "", timedOut: true }))
    const t = await getKey("poe", "POE_API_KEY")
    expect(!t.ok && !t.missing && t.reason).toContain("ne répond pas")
    setRunner(async () => ({ code: 1, out: "", err: "Cannot autolaunch D-Bus\nsuite", timedOut: false }))
    const e = await getKey("poe", "POE_API_KEY")
    expect(!e.ok && e.reason).toBe("erreur du trousseau : Cannot autolaunch D-Bus")
    setRunner(async () => ({ code: 0, out: "abc\n", err: "", timedOut: false }))
    const ok = await getKey("poe", "POE_API_KEY")
    expect(ok.ok && ok.key).toBe("abc")
  })
})

describe("détection des agents", () => {
  test("PATH réduit : agent dans ~/.local/bin non vu, puis trouvé par chemin manuel", async () => {
    const local = join(dir, "home", ".local", "bin")
    const claude = fakeExe(local, "claude")
    process.env.PATH = join(dir, "vide")
    let d = await detect()
    expect(d.find((x) => x.id === "claude")!.installed).toBe(false)
    expect(d.every((x) => x.installed || x.reason)).toBe(true) // absents rendus avec une raison, jamais cachés
    expect(d.length).toBe(AGENTS.length)
    d = await detect({ manual: { claude }, withVersion: true })
    const c = d.find((x) => x.id === "claude")!
    expect(c.installed && c.source).toBe("chemin indiqué à la main")
    expect(c.version).toBe("claude 1.2.3")
  })
  test("un agent qui plante ou ne répond pas ne bloque pas les autres", async () => {
    const bin = join(dir, "bin")
    fakeExe(bin, "codex", "#!/bin/sh\nexit 3\n")
    fakeExe(bin, "gemini", "#!/bin/sh\n/bin/sleep 5\n")
    fakeExe(bin, "opencode")
    process.env.PATH = bin
    const d = await detect({ withVersion: true, timeoutMs: 500 })
    expect(d.find((x) => x.id === "opencode")!.version).toBe("opencode 1.2.3")
    expect(d.find((x) => x.id === "gemini")!.versionError).toContain("sans réponse")
    expect(d.find((x) => x.id === "codex")!.installed).toBe(true)
  })
  test("ordre de recherche : PATH avant les autres sources", () => {
    const a = fakeExe(join(dir, "a"), "claude")
    fakeExe(join(dir, "b"), "claude")
    expect(locate(AGENTS[0], [[join(dir, "a"), "PATH"], [join(dir, "b"), "dossier d'installation courant"]])).toEqual({ path: a, source: "PATH" })
  })
})

describe("réglages et récents", () => {
  test("plusieurs modèles récents, sans doublon, le dernier en tête, rechargés", () => {
    let st = load()
    st = choose(st, { kind: "api", provider: "poe", model: "a" }, 1)
    st = choose(st, { kind: "agent", provider: "claude" }, 2)
    st = choose(st, { kind: "api", provider: "poe", model: "a" }, 3)
    save(st)
    const back = load()
    expect(back.recents.map((r) => r.model ?? r.provider)).toEqual(["a", "claude"])
    expect(back.current).toEqual({ kind: "api", provider: "poe", model: "a" })
  })
  test("reprend les modèles récents de la version Python", () => {
    mkdirSync(process.env.PNC_HOME!, { recursive: true })
    writeFileSync(join(process.env.PNC_HOME!, "config.json"), JSON.stringify({ recent_models: ["m1", "m2"] }))
    expect(load().recents.map((r) => r.model)).toEqual(["m1", "m2"])
  })
})

describe("conversation en flux", () => {
  test("texte, réflexion, consommation, puis fin", async () => {
    process.env.LMS = "1"
    const sse = ['data: {"choices":[{"delta":{"reasoning":"je pense"}}]}', 'data: {"choices":[{"delta":{"content":"Bon"}}]}',
                 'data: {"choices":[{"delta":{"content":"jour"}}]}', 'data: {"usage":{"prompt_tokens":5,"completion_tokens":2},"choices":[]}', "data: [DONE]"].join("\n\n")
    const fake = (async () => new Response(sse, { status: 200 })) as unknown as typeof fetch
    const evs = []
    for await (const e of streamChat(PROVIDERS.find((p) => p.id === "lmstudio")!, "m", [{ role: "user", content: "salut" }], { fetchImpl: fake })) evs.push(e)
    expect(evs).toEqual([{ type: "thinking", text: "je pense" }, { type: "text", text: "Bon" }, { type: "text", text: "jour" },
                         { type: "usage", input: 5, output: 2 }, { type: "done" }])
  })
  test("erreur HTTP expliquée en français", async () => {
    const fake = (async () => new Response(JSON.stringify({ error: { message: "does not support tool calling" } }), { status: 400 })) as unknown as typeof fetch
    const evs = []
    for await (const e of streamChat(PROVIDERS.find((p) => p.id === "lmstudio")!, "m", [], { fetchImpl: fake })) evs.push(e)
    expect(evs[0]).toEqual({ type: "error", message: "HTTP 400 — requête refusée : does not support tool calling" })
  })
})

describe("processus", () => {
  test("délai dépassé : le programme et ses enfants sont tués, rien ne reste", async () => {
    const { runCmd, liveCount } = await import("../src/core/proc")
    const t0 = Date.now()
    const r = await runCmd(["/bin/sh", "-c", "/bin/sleep 30 & /bin/sleep 30; echo fin"], { timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(liveCount()).toBe(0)
    const ps = Bun.spawnSync(["pgrep", "-f", "/bin/sleep 30"]).stdout.toString().trim()
    expect(ps).toBe("")
  })
})

describe("vérification de la clé", () => {
  test("Poe : catalogue public, mais la clé se vérifie sur le solde (401 = refusée)", async () => {
    const { verifyKey, provider } = await import("../src/core/providers")
    const urls: string[] = []
    const fake = (code: number) => (async (u: string) => { urls.push(String(u)); return new Response("{}", { status: code }) }) as unknown as typeof fetch
    expect((await verifyKey(provider("poe")!, { key: "x", fetchImpl: fake(401) })).check).toBe("refusée")
    expect(urls[0]).toBe("https://api.poe.com/usage/current_balance")
    expect((await verifyKey(provider("poe")!, { key: "x", fetchImpl: fake(200) })).check).toBe("valide")
    expect((await verifyKey(provider("openrouter")!, { key: "x", fetchImpl: fake(500) })).check).toBe("non vérifiée")
    const neterr = (async () => { throw new Error("réseau") }) as unknown as typeof fetch
    expect((await verifyKey(provider("openai")!, { key: "x", fetchImpl: neterr })).check).toBe("non vérifiée")
  })
})

describe("vérification de la clé", () => {
  test("Poe : catalogue public, mais la clé se vérifie sur le solde (401 = refusée)", async () => {
    const { verifyKey, provider } = await import("../src/core/providers")
    const urls: string[] = []
    const fake = (code: number) => (async (u: string) => { urls.push(String(u)); return new Response("{}", { status: code }) }) as unknown as typeof fetch
    expect((await verifyKey(provider("poe")!, { key: "x", fetchImpl: fake(401) })).check).toBe("refusée")
    expect(urls[0]).toBe("https://api.poe.com/usage/current_balance")
    expect((await verifyKey(provider("poe")!, { key: "x", fetchImpl: fake(200) })).check).toBe("valide")
    expect((await verifyKey(provider("openrouter")!, { key: "x", fetchImpl: fake(500) })).check).toBe("non vérifiée")
    const neterr = (async () => { throw new Error("réseau") }) as unknown as typeof fetch
    expect((await verifyKey(provider("openai")!, { key: "x", fetchImpl: neterr })).check).toBe("non vérifiée")
  })
})
