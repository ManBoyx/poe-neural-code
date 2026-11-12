"""Faux exécutable `claude` pour les tests : rejoue un scénario JSON (FAKE_CLAUDE_SCENARIO) au format stream-json réel
observé, et peut appeler le pont MCP d'Eclipse comme le ferait Claude Code. Journalise argv/stdin dans FAKE_CLAUDE_LOG."""
import asyncio
import json
import os
import sys
import time


def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


async def call_bridge(cfg_path, name, args):
    import httpx  # noqa
    from mcp import ClientSession
    from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
    srv = json.load(open(cfg_path))["mcpServers"]["eclipse"]
    http = create_mcp_http_client(headers=srv["headers"])
    async with streamable_http_client(srv["url"], http_client=http) as streams:
        r, w = streams[0], streams[1]
        async with ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool(name, args)
            return "".join(getattr(b, "text", "") for b in res.content)


def main():
    argv = sys.argv[1:]
    stdin = sys.stdin.read()
    log = os.environ.get("FAKE_CLAUDE_LOG")
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"argv": argv, "stdin": stdin}) + "\n")
    cfg = argv[argv.index("--mcp-config") + 1] if "--mcp-config" in argv else None
    for step in json.load(open(os.environ["FAKE_CLAUDE_SCENARIO"])):
        if "sleep" in step:
            time.sleep(step["sleep"])
        elif "call_tool" in step:
            out = asyncio.run(call_bridge(cfg, step["call_tool"]["name"], step["call_tool"]["arguments"]))
            if log:
                with open(log, "a") as f:
                    f.write(json.dumps({"tool_result": out}) + "\n")
        elif "exit" in step:
            sys.exit(step["exit"])
        else:
            emit(step)


main()
