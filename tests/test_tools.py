import asyncio
import os
import sys
import time

import pytest

from poe_neural_code.config import Config
from poe_neural_code.tools.base import TodoList, ToolContext
from poe_neural_code.tools.exec_tool import RunCommand
from poe_neural_code.tools.fs_tools import DeleteFile, EditFile, ListDir, ReadFile, SearchFiles, WriteFile
from poe_neural_code.tools.permissions import AdminRefused, PermissionManager, check_command
from poe_neural_code.tools.workspace import Workspace


def make_ctx(root, asker=None, **cfg):
    return ToolContext(Workspace(root), Config(**cfg), PermissionManager(asker), TodoList(), asyncio.Event())


def run(coro):
    return asyncio.run(coro)


def test_workspace_blocks_escape_and_symlinks(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("x")
    (root / "link").symlink_to(outside)
    ws = Workspace(root)
    assert ws.resolve("a/b.py")[1] and not ws.resolve("../secret.txt")[1] and not ws.resolve("/etc/passwd")[1]
    assert not ws.resolve("link")[1]  # lien symbolique vers l'extérieur


def test_read_inside_free_outside_requires_permission(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.txt").write_text("l1\nl2\nl3")
    (tmp_path / "out.txt").write_text("secret")
    ctx = make_ctx(root)
    t = ReadFile()
    assert run(t.prepare({"path": "a.txt"}, ctx)) is None
    assert run(t.run({"path": "a.txt", "start": 2, "end": 3}, ctx)).output == "2\tl2\n3\tl3"
    req = run(t.prepare({"path": "../out.txt"}, ctx))
    assert req.outside and not run(ctx.permissions.authorize(req))  # aucun demandeur → refus


def test_write_shows_diff_and_needs_approval(tmp_path):
    ctx = make_ctx(tmp_path)
    (tmp_path / "f.py").write_text("a = 1\n")
    t = WriteFile()
    req = run(t.prepare({"path": "f.py", "content": "a = 2\n"}, ctx))
    assert req.kind == "write" and "-a = 1" in req.detail and "+a = 2" in req.detail
    assert not run(ctx.permissions.authorize(req))
    assert (tmp_path / "f.py").read_text() == "a = 1\n"  # rien appliqué sans accord
    r = run(t.run({"path": "f.py", "content": "a = 2\n"}, ctx))
    assert r.ok and (tmp_path / "f.py").read_text() == "a = 2\n"


def test_edit_requires_unique_match(tmp_path):
    ctx = make_ctx(tmp_path)
    (tmp_path / "f.py").write_text("x\nx\n")
    t = EditFile()
    assert not run(t.run({"path": "f.py", "old_string": "x", "new_string": "y"}, ctx)).ok
    (tmp_path / "f.py").write_text("x\nz\n")
    assert run(t.run({"path": "f.py", "old_string": "x", "new_string": "y"}, ctx)).ok


def test_session_grant_for_edits_but_never_for_outside_or_destructive(tmp_path):
    asks = []

    async def asker(req):
        asks.append(req.summary)
        return "session"

    ctx = make_ctx(tmp_path, asker)
    t = WriteFile()
    for n in ("a", "b"):
        req = run(t.prepare({"path": f"{n}.txt", "content": "1"}, ctx))
        assert run(ctx.permissions.authorize(req))
    assert len(asks) == 1  # la seconde écriture est couverte par la session
    for i in range(2):  # destructif : redemandé à chaque fois
        (tmp_path / "d.txt").write_text("x")
        req = run(DeleteFile().prepare({"path": "d.txt"}, ctx))
        assert req.destructive
        assert run(ctx.permissions.authorize(req))
    assert len(asks) == 3


def test_auto_accept_edits_option_only_inside(tmp_path):
    ctx = make_ctx(tmp_path)
    ctx.permissions.auto_accept_edits = True
    assert run(ctx.permissions.authorize(run(WriteFile().prepare({"path": "a.txt", "content": "1"}, ctx))))
    assert not run(ctx.permissions.authorize(run(WriteFile().prepare({"path": "../o.txt", "content": "1"}, ctx))))


def test_admin_refused_and_destructive_flagged():
    with pytest.raises(AdminRefused):
        check_command("sudo rm -rf /var")
    with pytest.raises(AdminRefused):
        check_command("ls && sudo reboot")
    assert check_command("rm -rf build")[0] and check_command("git reset --hard")[0]
    assert not check_command("pytest -q")[0]


def test_run_command_output_env_and_returncode(tmp_path, monkeypatch):
    monkeypatch.setenv("POE_API_KEY", "sk-secret-value-123")
    ctx = make_ctx(tmp_path)
    r = run(RunCommand().run({"command": "echo salut; echo KEY=${POE_API_KEY:-absente}"}, ctx))
    assert r.ok and "salut" in r.output and "KEY=absente" in r.output  # la clé n'est pas transmise aux enfants
    r = run(RunCommand().run({"command": "exit 3"}, make_ctx(tmp_path)))  # nouvel Event : un Event asyncio est lié à une boucle
    assert not r.ok and r.meta["returncode"] == 3
    assert make_ctx(tmp_path).workspace.root == tmp_path.resolve()


def test_command_runs_in_project_root(tmp_path):
    r = run(RunCommand().run({"command": "pwd"}, make_ctx(tmp_path)))
    assert str(tmp_path.resolve()) in r.output


def test_command_timeout_kills_process_tree(tmp_path):
    ctx = make_ctx(tmp_path)
    t0 = time.time()
    r = run(RunCommand().run({"command": f"sleep 30 & echo $! > {tmp_path}/pid; wait", "timeout_s": 1}, ctx))
    assert not r.ok and "délai" in r.output and time.time() - t0 < 10
    pid = int((tmp_path / "pid").read_text())
    time.sleep(0.3)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)  # le petit-fils a bien été tué (groupe de processus)


def test_command_cancel(tmp_path):
    ctx = make_ctx(tmp_path)

    async def go():
        task = asyncio.create_task(RunCommand().run({"command": "sleep 30"}, ctx))
        await asyncio.sleep(0.5)
        t0 = time.time()
        ctx.cancel.set()
        r = await task
        return r, time.time() - t0

    r, dt = run(go())
    assert not r.ok and "interrompu" in r.output and dt < 5


def test_command_output_truncated(tmp_path):
    r = run(RunCommand().run({"command": "yes x | head -c 100000"}, make_ctx(tmp_path)))
    assert "tronquée" in r.output and len(r.output) < 30_000


def test_outside_paths_in_command_need_outside_flag(tmp_path):
    ctx = make_ctx(tmp_path)
    assert run(RunCommand().prepare({"command": "cat /etc/hostname"}, ctx)).outside
    assert not run(RunCommand().prepare({"command": "pytest -q"}, ctx)).outside
    assert run(RunCommand().prepare({"command": "ls ../"}, ctx)).outside


def test_search_and_list(tmp_path):
    (tmp_path / "a.py").write_text("def foo():\n    pass\n")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.py").write_text("def foo(): pass")
    ctx = make_ctx(tmp_path)
    out = run(SearchFiles().run({"pattern": "def foo", "glob": "*.py"}, ctx)).output
    assert "a.py:1" in out and "node_modules" not in out
    assert "a.py" in run(ListDir().run({}, ctx)).output


def test_schema_validation():
    assert ReadFile().validate({"path": 3})
    assert ReadFile().validate({"path": "a", "extra": 1})
    assert ReadFile().validate({"path": "a"}) is None
