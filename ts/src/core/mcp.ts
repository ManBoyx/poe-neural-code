/**
 * Serveurs MCP : configurés dans `<données>/mcp.json` (format habituel {"mcpServers": {nom: {command, args, env} | {url}}})
 * et `<projet>/.eclipse/mcp.json`. Leurs outils sont ajoutés à ceux des modèles d'API, sous le nom `mcp__serveur__outil`.
 * Chaque appel passe par les permissions (lecture libre seulement si le serveur annonce l'outil « readOnlyHint »).
 * Un serveur qui ne démarre pas n'empêche pas les autres ; son erreur est montrée par /mcp.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "./paths"

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  disabled?: boolean
}

export interface McpTool {
  server: string
  name: string
  fullName: string
  description: string
  schema: unknown
  readOnly: boolean
}

export interface McpStatus {
  name: string
  source: string
  state: "connecté" | "erreur" | "désactivé" | "connexion…"
  tools: number
  error?: string
}

export function loadConfigs(cwd: string): { name: string; cfg: McpServerConfig; source: string }[] {
  const out: { name: string; cfg: McpServerConfig; source: string }[] = []
  for (const [file, source] of [[join(dataDir(), "mcp.json"), "global"], [join(cwd, ".eclipse", "mcp.json"), "projet"]] as const) {
    if (!existsSync(file)) continue
    try {
      const j = JSON.parse(readFileSync(file, "utf8"))
      for (const [name, cfg] of Object.entries(j.mcpServers ?? j.servers ?? {})) out.push({ name, cfg: cfg as McpServerConfig, source })
    } catch (e) {
      out.push({ name: file, cfg: { disabled: true }, source: `illisible : ${(e as Error).message}` })
    }
  }
  return out
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)

export class McpManager {
  clients = new Map<string, Client>()
  status: McpStatus[] = []
  tools: McpTool[] = []

  async start(cwd: string, onChange?: () => void): Promise<void> {
    await this.close()
    const cfgs = loadConfigs(cwd)
    this.status = cfgs.map((c) => ({ name: c.name, source: c.source, state: c.cfg.disabled ? "désactivé" : "connexion…", tools: 0 }))
    onChange?.()
    await Promise.all(cfgs.map(async (c, i) => {
      if (c.cfg.disabled) return
      try {
        const client = new Client({ name: "eclipse", version: "5.0.0" })
        const transport = c.cfg.url ? new StreamableHTTPClientTransport(new URL(c.cfg.url))
          : new StdioClientTransport({ command: c.cfg.command!, args: c.cfg.args ?? [], env: { ...(process.env as Record<string, string>), ...(c.cfg.env ?? {}) }, cwd, stderr: "ignore" })
        await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error("pas de réponse en 20 s")), 20_000))])
        const res = await client.listTools()
        this.clients.set(c.name, client)
        for (const t of res.tools) this.tools.push({ server: c.name, name: t.name, fullName: `mcp__${safe(c.name)}__${safe(t.name)}`, description: (t.description ?? "").slice(0, 500),
                                                     schema: t.inputSchema ?? { type: "object", properties: {} }, readOnly: !!(t as any).annotations?.readOnlyHint })
        this.status[i] = { ...this.status[i], state: "connecté", tools: res.tools.length }
      } catch (e) {
        this.status[i] = { ...this.status[i], state: "erreur", error: (e as Error).message.slice(0, 200) }
      }
      onChange?.()
    }))
  }

  openAiTools() {
    return this.tools.map((t) => ({ type: "function", function: { name: t.fullName, description: `[MCP ${t.server}] ${t.description}`, parameters: t.schema } }))
  }

  find(fullName: string): McpTool | undefined {
    return this.tools.find((t) => t.fullName === fullName)
  }

  async call(t: McpTool, args: unknown): Promise<{ ok: boolean; output: string }> {
    const c = this.clients.get(t.server)
    if (!c) return { ok: false, output: `serveur MCP ${t.server} non connecté` }
    try {
      const r: any = await c.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> })
      const text = (r.content ?? []).map((x: any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n")
      return { ok: !r.isError, output: text.slice(0, 30_000) || "(réponse vide)" }
    } catch (e) {
      return { ok: false, output: `erreur MCP : ${(e as Error).message}` }
    }
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await c.close().catch(() => {})
    this.clients.clear()
    this.tools = []
  }
}
