import process from "node:process";

const [agent, executable, access, format] = process.argv.slice(2);
const write = access === "write";
const taskSchema = {
  type: "object",
  properties: { task: { type: "string" }, write: { type: "boolean" } },
  required: ["task", "write"],
  additionalProperties: false,
};
const planSchema = format === "plan" ? {
  type: "object",
  properties: { first: { type: "string", enum: ["claude", "codex"] }, claude: taskSchema, codex: taskSchema },
  required: ["first", "claude", "codex"],
  additionalProperties: false,
} : undefined;
let prompt = "";
for await (const chunk of process.stdin.setEncoding("utf8")) {
  prompt += chunk;
}

async function codex() {
  const { Codex } = await import("@openai/codex-sdk");
  const client = new Codex({ codexPathOverride: executable });
  const thread = client.startThread({
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    sandboxMode: write ? "workspace-write" : "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
  });
  return (await thread.run(prompt, { outputSchema: planSchema })).finalResponse;
}

async function claude() {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const options = {
    pathToClaudeCodeExecutable: executable,
    cwd: process.cwd(),
    settingSources: [],
    persistSession: false,
    permissionMode: write ? "acceptEdits" : "plan",
    tools: write ? ["Read", "Grep", "Glob", "Edit", "Write"] : ["Read", "Grep", "Glob"],
  };
  if (planSchema) options.outputFormat = { type: "json_schema", schema: planSchema };
  for await (const event of query({ prompt, options })) {
    if (event.type !== "result") continue;
    if (event.subtype === "success" && !event.is_error) {
      return planSchema && event.structured_output != null ? JSON.stringify(event.structured_output) : event.result;
    }
    throw new Error(event.errors?.join("\n") || event.result || event.subtype);
  }
  throw new Error("Claude Code a terminé sans résultat.");
}

try {
  if (agent === "check") {
    for (const [name, load, expected] of [
      ["Codex", () => import("@openai/codex-sdk"), "Codex"],
      ["Claude Code", () => import("@anthropic-ai/claude-agent-sdk"), "query"],
    ]) {
      try {
        if (typeof (await load())[expected] !== "function") throw new Error("interface SDK incompatible");
      } catch (error) {
        process.stderr.write(`SDK ${name} indisponible : ${error.message}`);
        process.exitCode = error.code === "ERR_MODULE_NOT_FOUND" ? 10 : 1;
        break;
      }
    }
    if (!process.exitCode) process.stdout.write("OK");
  } else {
    const result = await (agent === "codex" ? codex() : claude());
    process.stdout.write(result);
  }
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
