/**
 * Lancement de programmes externes sans orphelins : chaque programme démarre dans son propre groupe de processus.
 * Un délai dépassé ou une annulation tue tout le groupe (le programme et ses enfants). Les groupes encore vivants
 * sont tués à la fermeture d'Eclipse (sortie normale, Ctrl+C, terminal fermé, arrêt demandé).
 */
const live = new Set<number>()

export function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)])
    else process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

function killAll(): void {
  for (const pid of live) killGroup(pid)
  live.clear()
}

let hooked = false
function hookExit(): void {
  if (hooked) return
  hooked = true
  process.on("exit", killAll)
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      killAll()
      process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const)[sig])
    })
  }
}

export function liveCount(): number {
  return live.size
}

export interface RunResult {
  code: number | null
  out: string
  err: string
  timedOut: boolean
}

/** Lance `cmd`, attend sa fin (ou le délai), renvoie la sortie. */
export async function runCmd(cmd: string[], opts: { input?: string; timeoutMs?: number; env?: Record<string, string | undefined>; cwd?: string; signal?: AbortSignal } = {}): Promise<RunResult> {
  hookExit()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(cmd, { stdin: opts.input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", detached: true,
                            env: opts.env as Record<string, string> | undefined, cwd: opts.cwd })
  } catch (e) {
    return { code: null, out: "", err: (e as Error).message, timedOut: false }
  }
  live.add(proc.pid)
  if (opts.input !== undefined && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(opts.input)
    proc.stdin.end()
  }
  let timedOut = false
  const stop = () => killGroup(proc.pid)
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, opts.timeoutMs ?? 30_000)
  opts.signal?.addEventListener("abort", stop, { once: true })
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
    const code = await proc.exited
    return { code: timedOut ? null : code, out, err, timedOut }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", stop)
    killGroup(proc.pid) // les enfants restés en arrière-plan ne survivent pas
    live.delete(proc.pid)
  }
}
