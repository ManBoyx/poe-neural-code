"""Skills (Agent Skills) : dossiers contenant SKILL.md (nom + description + instructions), chargés À LA DEMANDE par l'outil `skill`.

Emplacements : projet (.eclipse/skills, .claude/skills, .opencode/skills, .agents/skills) et global (~/.config/eclipse/skills,
~/.claude/skills, ~/.config/opencode/skills). Le catalogue (nom + description) est donné au modèle ; le contenu n'est chargé que si le
modèle appelle `skill`. Les skills du PROJET sont du contenu de dépôt (non fiable) : leur chargement demande une confirmation avec aperçu.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from ..tools.base import Tool, ToolContext, ToolResult
from ..tools.permissions import PermissionRequest
from .frontmatter import parse

PROJECT_DIRS = (".eclipse/skills", ".claude/skills", ".opencode/skills", ".agents/skills")
GLOBAL_DIRS = ("~/.config/eclipse/skills", "~/.claude/skills", "~/.config/opencode/skills")
MAX_BODY = 40_000


@dataclass
class Skill:
    name: str
    description: str
    path: Path
    scope: str  # project | global
    body: str
    sha: str

    @property
    def files(self) -> list[str]:
        return sorted(str(p.relative_to(self.path.parent)) for p in self.path.parent.rglob("*") if p.is_file() and p != self.path)[:40]


def discover_skills(root: Path, home: Path | None = None) -> dict[str, Skill]:
    home = home or Path.home()
    found: dict[str, Skill] = {}
    sources = [(root / d, "project") for d in PROJECT_DIRS] + [(Path(str(d).replace("~", str(home), 1)), "global") for d in GLOBAL_DIRS]
    for base, scope in sources:
        if not base.is_dir():
            continue
        for f in sorted(base.glob("*/SKILL.md")):
            try:
                text = f.read_text(encoding="utf-8")
            except OSError:
                continue
            fields, body, _ = parse(text)
            name = fields.get("name") or f.parent.name
            if name in found or not body:
                continue  # le premier trouvé gagne (projet avant global)
            found[name] = Skill(name, fields.get("description", ""), f, scope, body[:MAX_BODY], hashlib.sha256(text.encode()).hexdigest()[:12])
    return found


def catalog_text(skills: dict[str, Skill]) -> str:
    if not skills:
        return ""
    lines = ["## Skills disponibles (chargez-en un avec l'outil `skill` quand il est pertinent)"]
    lines += [f"- {s.name}: {s.description or '(sans description)'}" for s in skills.values()]
    return "\n".join(lines)


class SkillTool(Tool):
    name = "skill"
    description = "Charge les instructions détaillées d'un skill (voir le catalogue dans le prompt système)."
    schema = {"type": "object", "properties": {"name": {"type": "string", "minLength": 1}}, "required": ["name"], "additionalProperties": False}

    def __init__(self, get_skills):
        self.get_skills = get_skills

    async def prepare(self, args, ctx: ToolContext):
        s = self.get_skills().get(args["name"])
        if s is None or s.scope == "global":
            return None
        return PermissionRequest(self.name, "skill", f"Charger le skill du PROJET « {s.name} »", s.body[:3000], grant_key=f"skill:{s.name}:{s.sha}",
                                 warnings=["contenu du dépôt (non fiable) : ces instructions seront transmises au modèle"])

    async def run(self, args, ctx: ToolContext):
        s = self.get_skills().get(args["name"])
        if s is None:
            return ToolResult(False, f"skill inconnu : {args['name']} (disponibles : {', '.join(self.get_skills()) or 'aucun'})")
        extra = ("\n\nFichiers associés (lisibles avec read_file) : " + ", ".join(s.files)) if s.files else ""
        return ToolResult(True, f"# Skill {s.name}\n{s.body}{extra}", {"skill": s.name})
