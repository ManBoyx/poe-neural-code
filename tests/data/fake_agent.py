"""Faux agent IA en ligne de commande pour les tests (format « texte » ou « opencode-json »). Scénario : FAKE_AGENT_SCENARIO (JSON)."""
import json
import os
import sys
import time

log = os.environ.get("FAKE_AGENT_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps({"argv": sys.argv[1:], "stdin": sys.stdin.read() if not sys.stdin.isatty() else ""}) + "\n")
for step in json.load(open(os.environ["FAKE_AGENT_SCENARIO"])):
    if "sleep" in step:
        time.sleep(step["sleep"])
    elif "exit" in step:
        sys.stderr.write(step.get("stderr", ""))
        sys.exit(step["exit"])
    elif "raw" in step:
        sys.stdout.write(step["raw"] + "\n")
        sys.stdout.flush()
    else:
        sys.stdout.write(json.dumps(step) + "\n")
        sys.stdout.flush()
