from __future__ import annotations

from .agent_tools import MemoryLoad, MemoryNote, MemorySearch, TodoWrite
from .base import Tool
from .exec_tool import RunCommand
from .fs_tools import DeleteFile, EditFile, ListDir, ReadFile, SearchFiles, WriteFile


def builtin_tools() -> dict[str, Tool]:
    tools = [ListDir(), ReadFile(), SearchFiles(), WriteFile(), EditFile(), DeleteFile(), RunCommand(),
             TodoWrite(), MemorySearch(), MemoryLoad(), MemoryNote()]
    return {t.name: t for t in tools}
