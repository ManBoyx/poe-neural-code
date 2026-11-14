from __future__ import annotations

from .agent_tools import MemoryLoad, MemoryNote, MemorySearch, TodoWrite
from .base import Tool
from .exec_tool import RunCommand
from .web_tool import WebFetch
from .fs_tools import DeleteFile, EditFile, ListDir, ReadFile, SearchFiles, WriteFile


def builtin_tools() -> dict[str, Tool]:
    tools = [ListDir(), ReadFile(), SearchFiles(), WriteFile(), EditFile(), DeleteFile(), RunCommand(),
             TodoWrite(), MemorySearch(), MemoryLoad(), MemoryNote(), WebFetch()]
    return {t.name: t for t in tools}
