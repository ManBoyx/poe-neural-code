"""Compatibilité Linux / Windows : shell, encodage, lanceurs npm, fins de ligne (Windows simulé)."""
import asyncio
import base64
import sys

import pytest

from poe_neural_code import platform_compat as PC
from tests.test_tools import make_ctx


def fake_which(table):
    return lambda name: table.get(name)


def test_pick_shell_linux_and_windows():
    assert PC.pick_shell("auto", "linux", fake_which({"bash": "/usr/bin/bash"})).name == "bash"
    assert PC.pick_shell("auto", "linux", fake_which({})).exe == "/bin/sh"
    win = {"pwsh": r"C:\PS7\pwsh.exe", "powershell": r"C:\Windows\powershell.exe", "cmd.exe": r"C:\Windows\cmd.exe", "wsl.exe": r"C:\Windows\wsl.exe"}
    assert PC.pick_shell("auto", "win32", fake_which(win)).name == "pwsh"
    assert PC.pick_shell("auto", "win32", fake_which({"powershell": win["powershell"]})).name == "powershell"
    assert PC.pick_shell("wsl", "win32", fake_which(win)).exe == win["wsl.exe"]
    assert PC.pick_shell("cmd", "win32", fake_which(win)).name == "cmd"


def test_powershell_encoded_command_keeps_quotes_and_accents():
    spec = PC.ShellSpec("pwsh", "PowerShell 7", "pwsh.exe")
    cmd = 'Write-Output "élève & \'quote\'" | Select-String "é"'
    argv, line = PC.shell_invocation(cmd, spec)
    assert line is None and argv[-2] == "-EncodedCommand"
    decoded = base64.b64decode(argv[-1]).decode("utf-16-le")
    assert decoded.endswith(cmd) and "UTF8" in decoded


def test_cmd_and_wsl_and_bash_invocations():
    argv, line = PC.shell_invocation("dir /b", PC.ShellSpec("cmd", "cmd", "cmd.exe"))
    assert argv is None and line.startswith("chcp 65001>nul & ")
    argv, _ = PC.shell_invocation("ls -la", PC.ShellSpec("wsl", "WSL", "wsl.exe"))
    assert argv == ["wsl.exe", "-e", "bash", "-lc", "ls -la"]
    argv, _ = PC.shell_invocation("echo hi", PC.ShellSpec("bash", "bash", "/usr/bin/bash"))
    assert argv == ["/usr/bin/bash", "-c", "echo hi"]


def test_environment_note_tells_model_the_syntax():
    assert "PowerShell syntax" in PC.environment_note(PC.ShellSpec("pwsh", "PowerShell 7", "x"), "win32")
    assert "Windows" in PC.environment_note(PC.ShellSpec("cmd", "cmd", "x"), "win32")
    assert PC.environment_note(PC.ShellSpec("bash", "bash", "x"), "linux").startswith("Operating system: Linux")


def test_resolve_argv_npm_shim(tmp_path):
    shim = tmp_path / "claude.cmd"
    (tmp_path / "node_modules" / "@anthropic-ai" / "claude-code").mkdir(parents=True)
    js = tmp_path / "node_modules" / "@anthropic-ai" / "claude-code" / "cli.js"
    js.write_text("//")
    shim.write_text('@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n', encoding="utf-8")
    which = fake_which({"claude": str(shim), "node": "/x/node.exe"})
    out = PC.resolve_argv(["claude", "-p", '{"a": "b c"}'], "win32", which)
    assert out[0] == "/x/node.exe" and out[1] == str(js.resolve()) and out[2:] == ["-p", '{"a": "b c"}']
    assert PC.resolve_argv(["claude", "-p"], "linux", which) == ["claude", "-p"]
    exe = fake_which({"codex": r"C:\bin\codex.exe"})
    assert PC.resolve_argv(["codex", "exec"], "win32", exe) == [r"C:\bin\codex.exe", "exec"]


def test_eol_preserved(tmp_path):
    f = tmp_path / "a.txt"
    f.write_bytes(b"un\r\ndeux\r\n")
    text, eol = PC.read_text_eol(f)
    assert text == "un\ndeux\n" and eol == "\r\n"
    PC.write_text_eol(f, text.replace("deux", "trois"), eol)
    assert f.read_bytes() == b"un\r\ntrois\r\n"
    g = tmp_path / "b.txt"
    PC.write_text_eol(g, "x\ny\n", PC.eol_for_new_file("lf", "win32"))
    assert g.read_bytes() == b"x\ny\n"
    assert PC.eol_for_new_file("native", "win32") == "\r\n" and PC.eol_for_new_file("native", "linux") == "\n"


def test_group_kwargs():
    assert PC.group_kwargs("linux") == {"start_new_session": True}
    assert "creationflags" in PC.group_kwargs("win32")


def test_edit_and_write_tools_keep_crlf(tmp_path):
    from poe_neural_code.tools.fs_tools import EditFile, WriteFile

    f = tmp_path / "w.bat"
    f.write_bytes(b"@echo off\r\necho un\r\n")
    ctx = make_ctx(tmp_path)

    async def go():
        r = await EditFile().run({"path": "w.bat", "old_string": "echo un\n", "new_string": "echo deux\n"}, ctx)
        assert r.ok, r.output
        assert f.read_bytes() == b"@echo off\r\necho deux\r\n"
        await WriteFile().run({"path": "w.bat", "content": "a\nb\n"}, ctx)
        assert f.read_bytes() == b"a\r\nb\r\n"
        await WriteFile().run({"path": "neuf.txt", "content": "a\r\nb\n"}, ctx)
        assert (tmp_path / "neuf.txt").read_bytes() == b"a\nb\n"

    asyncio.run(go())


@pytest.mark.skipif(sys.platform == "win32", reason="vérifié par la CI Windows avec PowerShell")
def test_run_command_uses_bash_and_utf8(tmp_path):
    from poe_neural_code.tools.exec_tool import RunCommand

    ctx = make_ctx(tmp_path)
    r = asyncio.run(RunCommand().run({"command": "echo élève; [[ 1 == 1 ]] && echo bash"}, ctx))
    assert "élève" in r.output and "bash" in r.output


@pytest.mark.skipif(sys.platform != "win32", reason="Windows uniquement (CI windows-latest)")
def test_run_command_windows_powershell_utf8(tmp_path):
    from poe_neural_code.tools.exec_tool import RunCommand

    ctx = make_ctx(tmp_path)
    r = asyncio.run(RunCommand().run({"command": 'Write-Output "élève"; $PSVersionTable.PSEdition'}, ctx))
    assert "élève" in r.output, r.output
    ctx.config.shell = "cmd"
    r = asyncio.run(RunCommand().run({"command": "echo élève"}, ctx))
    assert "élève" in r.output, r.output
