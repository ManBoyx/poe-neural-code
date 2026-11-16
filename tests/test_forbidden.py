"""Commandes TOUJOURS refusées : liste noire appliquée avant toute autorisation, dans tous les modes."""
import asyncio
import json

import pytest

from poe_neural_code.provider.base import TextDelta, ToolCall
from poe_neural_code.tools.permissions import ForbiddenCommand, check_command, forbidden_reason

REFUSED = ["rm -rf /", "rm -fr ~", "rm -rf --no-preserve-root /", "rm -r -f /home", "cd x && rm -rf $HOME", "rm -Rf /*", "rm -rf /usr/",
           "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sdb1", "/sbin/mkfs -t ext4 /dev/sdb", "echo x > /dev/sda", ":(){ :|:& };:",
           "shutdown now", "sudo -n true; reboot", "chmod -R 777 /", "Format-Volume -DriveLetter D", "format C:", "rd /s /q C:\\",
           "Remove-Item -Recurse -Force C:\\", "Remove-Item -Recurse $env:USERPROFILE", "diskpart", "vssadmin delete shadows /all",
           "cipher /w:C", "reg delete HKLM\\Software\\X", "Stop-Computer -Force", "wipefs -a /dev/sdb"]
ALLOWED = ["rm -rf ./build", "rm -rf build dist", "rm file.txt", "dd if=/dev/zero of=disk.img bs=1M count=10", "Remove-Item -Recurse ./tmp",
           "git push --force", "ls /", "cat /etc/hosts", "echo format", "rm -rf node_modules", "chmod -R 755 ./scripts",
           "grep -r shutdown src/", "npm run format", "echo diskpart", "man mkfs", "rg reboot -n"]


@pytest.mark.parametrize("cmd", REFUSED)
def test_refused(cmd):
    with pytest.raises(Exception):  # ForbiddenCommand, ou AdminRefused pour sudo
        check_command(cmd)


@pytest.mark.parametrize("cmd", ALLOWED)
def test_allowed_needs_confirmation_only(cmd):
    assert forbidden_reason(cmd) is None
    check_command(cmd)  # ne lève rien : la confirmation manuelle reste la règle


@pytest.mark.parametrize("mode,bypass_all", [("edits", False), ("bypass", False), ("bypass", True)])
def test_refused_even_in_auto_edits_and_bypass(tmp_path, mode, bypass_all):
    asked = []
    from poe_neural_code.config import Config
    from poe_neural_code.services import create_services
    from tests.conftest import FakeProvider

    async def asker(req):
        asked.append(req)
        return "once"
    prov = FakeProvider([[ToolCall("x", "run_command", json.dumps({"command": "rm -rf ~"}))], [TextDelta("compris")]])
    svc = create_services(tmp_path, provider=prov, asker=asker, config=Config(model="m1"))
    svc.ctx.permissions.set_mode(mode, bypass_all=bypass_all)
    asyncio.run(svc.run_user_turn("nettoie tout"))
    tool_msg = next(m for m in svc.agent.messages if m.get("role") == "tool")
    assert "toujours refusée" in tool_msg["content"] and asked == []  # refusé sans même demander
    asyncio.run(svc.close())
