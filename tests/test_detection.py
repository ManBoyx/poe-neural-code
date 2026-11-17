"""Détection des agents (4.0.0) : PATH réduit comme dans une AppImage, ~/.local/bin, absent, agent qui plante, chemin manuel,
PATH du shell de connexion, liens symboliques, environnement de lancement ; niveaux d'effort ; 3 blocs de connexions."""
import asyncio
import json
import os
import stat
import sys
import time
from pathlib import Path

import httpx
import pytest

from poe_neural_code import cli_agents as CA
from poe_neural_code import connections as CX
from poe_neural_code import credentials, variants
from poe_neural_code.config import Config, load_config, save_config
from poe_neural_code.provider.base import ParamSpec

REDUCED = "/usr/bin:/bin"  # PATH d'une session graphique (AppImage lancée depuis le menu) : ni ~/.local/bin ni ~/.opencode/bin


def exe(path: Path, body: str = "echo v1.0.0") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@pytest.fixture
def full_scan(monkeypatch):
    monkeypatch.setenv("ECLIPSE_AGENT_SCAN", "full")
    monkeypatch.setattr(CA, "_shell_cache", None)


def by_id(found):
    return {d.adapter.id: d for d in found}


def test_reduced_path_like_appimage_finds_agents_via_shell_path(tmp_path, monkeypatch):
    shell_bin = tmp_path / "shell-bin"
    exe(shell_bin / "opencode", "echo opencode v2.1.4")
    exe(shell_bin / "claude", "echo '2.1.325 (Claude Code)'")
    dirs = CA.search_dirs(env_path=REDUCED, shell_dirs=[str(shell_bin)], home=tmp_path / "vide")
    found = by_id(CA.detect(with_version=True, dirs=dirs, config=Config()))
    assert found["opencode"].installed and found["opencode"].source == CA.SRC_SHELL and found["opencode"].version == "opencode v2.1.4"
    assert found["claude"].installed and "2.1.325" in found["claude"].version
    # sans le PATH du shell : introuvables (c'était le bug), avec une raison précise
    found = by_id(CA.detect(dirs=CA.search_dirs(env_path=REDUCED, shell_dirs=[], home=tmp_path / "vide"), config=Config()))
    assert not found["opencode"].installed and "« opencode » introuvable" in found["opencode"].reason


def test_program_in_local_bin_found_with_reduced_path_and_symlink_followed(tmp_path):
    home = tmp_path / "home"
    target = exe(home / ".local" / "share" / "claude" / "versions" / "2.1.325", "echo '2.1.325 (Claude Code)'")
    (home / ".local" / "bin").mkdir(parents=True)
    (home / ".local" / "bin" / "claude").symlink_to(target)
    exe(home / ".opencode" / "bin" / "opencode")
    exe(home / ".nvm" / "versions" / "node" / "v20.1.0" / "bin" / "codex")
    exe(home / ".nvm" / "versions" / "node" / "v22.3.0" / "bin" / "codex")
    found = by_id(CA.detect(with_version=True, dirs=CA.search_dirs(env_path=REDUCED, shell_dirs=[], home=home), config=Config()))
    c = found["claude"]
    assert c.installed and c.path == str(home / ".local" / "bin" / "claude") and c.real_path == str(target) and c.source == CA.SRC_KNOWN
    assert found["opencode"].installed
    assert "v22.3.0" in found["codex"].path  # version de Node la plus récente d'abord


def test_absent_program_is_listed_greyed_with_reason(tmp_path):
    found = by_id(CA.detect(dirs=CA.search_dirs(env_path=str(tmp_path), shell_dirs=[], home=tmp_path), config=Config()))
    assert set(found) >= {"claude", "opencode", "gemini", "codex", "kiro", "aider", "goose", "qwen", "cursor", "copilot", "amp", "crush", "droid", "cline"}
    k = found["kiro"]
    assert not k.installed and "« kiro-cli » introuvable" in k.reason and "dossiers" in k.reason
    j = k.to_json()
    assert j["installed"] is False and j["path"] is None and j["reason"]


def test_one_crashing_or_hanging_agent_never_blocks_the_others(tmp_path, monkeypatch):
    b = tmp_path / "bin"
    exe(b / "gemini", "sleep 30")  # --version ne répond jamais
    exe(b / "opencode", "echo opencode v9")
    exe(b / "codex", "exit 3")  # aucune version
    real_locate = CA.locate

    def boom(a, dirs=None, manual=None):
        if a.id == "aider":
            raise RuntimeError("plantage simulé")
        return real_locate(a, dirs, manual)

    monkeypatch.setattr(CA, "locate", boom)
    t = time.time()
    found = by_id(CA.detect(with_version=True, dirs=[(str(b), CA.SRC_PATH)], config=Config(), timeout=1.0))
    assert time.time() - t < 10
    assert found["gemini"].installed and "sans réponse" in found["gemini"].version_error
    assert found["opencode"].version == "opencode v9"
    assert found["codex"].installed and found["codex"].version_error
    assert not found["aider"].installed and "plantage simulé" in found["aider"].reason
    assert found["claude"].reason  # les autres sont tous présents


def test_manual_path_has_priority_invalid_one_falls_back_with_warning(tmp_path):
    b = tmp_path / "bin"
    auto = exe(b / "claude")
    manual = exe(tmp_path / "ailleurs" / "mon-claude")
    found = by_id(CA.detect(dirs=[(str(b), CA.SRC_PATH)], config=Config(agent_paths={"claude": str(manual)})))
    assert found["claude"].path == str(manual) and found["claude"].source == CA.SRC_MANUAL
    found = by_id(CA.detect(dirs=[(str(b), CA.SRC_PATH)], config=Config(agent_paths={"claude": str(tmp_path / "absent")})))
    assert found["claude"].path == str(auto) and "chemin indiqué à la main ignoré" in found["claude"].reason
    # ancien réglage claude_bin : même effet
    found = by_id(CA.detect(dirs=[], config=Config(claude_bin=str(manual))))
    assert found["claude"].source == CA.SRC_MANUAL


def test_set_agent_path_validates_and_persists(tmp_path):
    good = exe(tmp_path / "x" / "kiro-cli")
    notexec = tmp_path / "x" / "texte"
    notexec.write_text("rien")
    ok, msg, _ = CX.set_agent_path("kiro", str(notexec))
    assert not ok and "n'est pas exécutable" in msg and "kiro" not in load_config().agent_paths
    ok, msg, d = CX.set_agent_path("kiro", str(good))
    assert ok and d["installed"] and load_config().agent_paths["kiro"] == str(good)
    assert CA.find_binary("kiro") == str(good)
    ok, msg, _ = CX.set_agent_path("kiro", "")
    assert ok and "kiro" not in load_config().agent_paths
    assert CX.set_agent_path("inconnu", "/bin/sh")[0] is False


def test_shell_path_read_from_login_shell_with_noise_and_timeout(tmp_path, monkeypatch, full_scan):
    fake = exe(tmp_path / "zsh", 'echo "bienvenue, fastfetch…"; printf "__ECLIPSE_PATH__/a/bin:/b/bin__ECLIPSE_PATH__"; echo fin')
    monkeypatch.setenv("SHELL", str(fake))
    dirs, err = CA.shell_path(refresh=True)
    assert dirs == ["/a/bin", "/b/bin"] and err == ""
    slow = exe(tmp_path / "bash", "sleep 10")
    monkeypatch.setenv("SHELL", str(slow))
    dirs, err = CA.shell_path(refresh=True, timeout=0.5)
    assert dirs == [] and "n'a pas répondu" in err
    monkeypatch.setenv("SHELL", str(tmp_path / "absent"))
    assert CA.shell_path(refresh=True)[1] == "shell de connexion introuvable"


def test_launch_env_completes_path_for_node_scripts(tmp_path, monkeypatch):
    b = exe(tmp_path / "nvm" / "bin" / "gemini")
    env = CA.agent_env(str(b), {"PATH": REDUCED, "HOME": str(tmp_path)})
    parts = env["PATH"].split(os.pathsep)
    assert parts[0] == str(b.parent) and "/usr/bin" in parts  # node installé à côté du script trouvé en premier


def test_runner_uses_detected_binary_not_bare_name(tmp_path, monkeypatch):
    """Lancé depuis le menu, « opencode » seul ne serait pas trouvé : le lanceur reçoit le chemin complet."""
    from poe_neural_code.services import create_services
    from tests.conftest import FakeProvider
    oc = exe(tmp_path / "home" / ".opencode" / "bin" / "opencode")
    monkeypatch.setenv("PATH", REDUCED)
    monkeypatch.setattr(CA, "search_dirs", lambda env_path=None, shell_dirs=None, home=None, refresh=False: [(str(oc.parent), CA.SRC_KNOWN)])
    proj = tmp_path / "p"
    proj.mkdir()
    sv = create_services(proj, provider=FakeProvider([]), config=Config())
    sv.set_mode("cli:opencode")
    assert sv.delegated_runner().binary == str(oc)


def test_claude_runner_keeps_replaced_command():
    """Garde-fou : une commande Claude remplacée après coup (ex. faux Claude des tests) n'est JAMAIS remplacée par le vrai."""
    from poe_neural_code.claude_runner import ClaudeCodeRunner
    r = ClaudeCodeRunner.__new__(ClaudeCodeRunner)
    r.config, r._fixed_cmd, r.claude_cmd = Config(), False, ["claude"]
    r.claude_cmd = [sys.executable, "faux.py"]
    assert r._argv0() == [sys.executable, "faux.py"]


# ------------------------------------------------------------------ effort : rapide / normal / profond
def test_effort_levels_map_to_real_model_values():
    p3 = ParamSpec("reasoning_effort", "enum", ["low", "medium", "high"], "medium")
    assert [variants.level_value(p3, lv) for lv in variants.LEVELS] == ["low", "medium", "high"]
    claude = variants.claude_params()[0]  # low medium high xhigh max
    assert variants.level_value(claude, "profond") == "high" and variants.level_value(claude, "rapide") == "low"
    odd = ParamSpec("thinking_level", "enum", ["minimal", "deep", "ultra"], None)
    assert variants.level_value(odd, "rapide") == "minimal" and variants.level_value(odd, "normal") == "deep" and variants.level_value(odd, "profond") == "ultra"
    assert variants.level_value(p3, "défaut") is None and variants.level_value(None, "rapide") is None
    assert variants.level_of(p3, "high") == "profond" and variants.level_of(p3, None) is None
    assert variants.effective([p3], {}, "rapide") == {"reasoning_effort": "low"}
    assert variants.effective([p3], {"reasoning_effort": "high"}, "rapide") == {"reasoning_effort": "high"}  # choix explicite prioritaire
    assert variants.effective([], {}, "profond") == {}  # modèle sans effort : rien d'inventé


def test_default_effort_applied_by_agent_and_claude_command(tmp_path):
    from poe_neural_code.claude_runner import ClaudeCodeRunner
    from poe_neural_code.provider.base import ModelInfo
    from poe_neural_code.services import create_services
    from tests.conftest import FakeProvider
    cfg = Config(default_effort="profond")
    sv = create_services(tmp_path, provider=FakeProvider([]), config=cfg)
    sv.models["m"] = ModelInfo("m", 1000, 100, 0, 0, True, params=[ParamSpec("reasoning_effort", "enum", ["low", "medium", "high"], None)])
    sv.session.model = "m"
    assert sv.agent.options() == {"reasoning_effort": "high"}
    cmd = sv.claude._command("/tmp/x.json", False)
    assert cmd[cmd.index("--effort") + 1] == "high"
    with pytest.raises(Exception):
        Config(default_effort="énorme")


# ------------------------------------------------------------------ connexions : 3 blocs
def test_api_block_reports_key_source_never_the_key(monkeypatch):
    credentials.set_key("openrouter", "sk-secret-123456")
    monkeypatch.setenv("GROQ_API_KEY", "gsk-env-999999")
    apis = {a["provider"]: a for a in CX.apis()}
    assert apis["openrouter"]["key_source"] == "trousseau" and apis["groq"]["key_source"] == "variable GROQ_API_KEY"
    assert apis["openai"]["has_key"] is False and "lmstudio" not in apis and "ollama" not in apis
    assert "sk-secret" not in json.dumps(apis) and "gsk-env" not in json.dumps(apis)
    ok, msg = CX.forget_key("openrouter")
    assert ok and credentials.get_key("openrouter") is None
    ok, msg = CX.forget_key("groq")
    assert not ok and "GROQ_API_KEY reste prise en compte" in msg


def test_local_servers_probe_running_and_stopped():
    def h(req):
        if req.url.port == 1234:
            return httpx.Response(200, json={"data": [{"id": "qwen2.5-coder-7b"}, {"id": "llama-3.2-3b"}]})
        raise httpx.ConnectError("refus", request=req)

    res = {s["provider"]: s for s in asyncio.run(CX.local_servers(httpx.MockTransport(h)))}
    assert res["lmstudio"]["running"] and res["lmstudio"]["models"] == ["qwen2.5-coder-7b", "llama-3.2-3b"]
    assert res["lmstudio"]["url"] == "http://localhost:1234/v1"
    assert not res["ollama"]["running"] and "arrêté" in res["ollama"]["error"]


def test_add_server_rules():
    ok, msg, spec = CX.add_server("Mon serveur", "http://localhost:8080/v1/")
    assert ok and spec.base_url == "http://localhost:8080/v1" and not spec.key_required and CX.is_local(spec)
    assert any(s.id == spec.id for s in CX.local_specs())
    ok, msg, _ = CX.add_server("x", "http://exemple.com/v1")
    assert not ok and "https" in msg  # la clé circulerait en clair
    ok, msg, spec = CX.add_server("Distant", "https://exemple.com/v1")
    assert ok and spec.key_required and any(a["provider"] == spec.id for a in CX.apis())
    assert CX.add_server("", "pas-une-url")[0] is False
    ok, _, spec = CX.add_server("openai", "http://127.0.0.1:9000/v1")  # ne remplace jamais un préréglage
    assert spec.id == "openai-perso"
