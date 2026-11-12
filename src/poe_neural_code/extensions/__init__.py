"""Extensions : skills, plugins, modes, commandes personnalisées — rechargeables avec /reload."""
from __future__ import annotations

from pathlib import Path

from . import commands as C
from .modes import Mode, load_modes
from .plugins import PluginRegistry
from .skills import Skill, discover_skills


class Extensions:
    def __init__(self, root: Path, home: Path | None = None, trust_file: Path | None = None):
        self.root, self.home = Path(root), home
        self.skills: dict[str, Skill] = {}
        self.modes: dict[str, Mode] = {}
        self.custom: dict[str, C.Command] = {}
        self.plugins = PluginRegistry(trust_file)
        self.reload()

    def reload(self) -> None:
        self.skills = discover_skills(self.root, self.home)
        self.modes = load_modes(self.root, self.home)
        self.custom = C.custom_commands(self.root, self.home)
        self.plugins.discover(self.root, self.home)
        self.plugins.load_trusted()

    def commands(self) -> list[C.Command]:
        return C.all_commands(self.custom, self.skills, self.plugins.commands)
