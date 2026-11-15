"""Sessions : état de travail local sauvegardé en JSON (reprise automatique). La mémoire vit dans memory.db."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field

from .paths import sessions_dir


@dataclass
class Session:
    id: str
    workspace: str
    district_id: int
    conversation_id: int
    model: str | None = None
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    todos: list[dict] = field(default_factory=list)
    messages: list[dict] = field(default_factory=list)  # fil récent au format fournisseur (borné à la sauvegarde)
    title: str = ""
    mode: str = "poe"  # poe | claude
    claude_session_id: str | None = None
    cli_sessions: dict = field(default_factory=dict)  # agent externe -> identifiant de session de l'agent
    provider_models: dict = field(default_factory=dict)  # fournisseur -> dernier modèle choisi
    extra_dirs: list = field(default_factory=list)
    agent: str = "build"  # profil d'agent actif (build, plan, ou personnalisé)
    model_options: dict = field(default_factory=dict)  # modèle -> {réglage: valeur}
    undo_stack: list = field(default_factory=list)
    redo_stack: list = field(default_factory=list)
    baseline_tree: str | None = None  # état des fichiers au début de la conversation (diff global, « Tout annuler »)

    @staticmethod
    def new(workspace: str, district_id: int, conversation_id: int, model: str | None) -> "Session":
        return Session(uuid.uuid4().hex[:10], workspace, district_id, conversation_id, model)

    def save(self, max_messages: int = 60) -> None:
        self.updated = time.time()
        d = self.__dict__.copy()
        d["messages"] = self.messages[-max_messages:]
        tmp = sessions_dir() / f"{self.id}.json.tmp"
        tmp.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        tmp.replace(sessions_dir() / f"{self.id}.json")  # écriture atomique

    @staticmethod
    def load(sid: str) -> "Session":
        return Session(**json.loads((sessions_dir() / f"{sid}.json").read_text(encoding="utf-8")))


def delete_session(sid: str) -> bool:
    """Supprime l'état de travail de la session (fichier JSON). Les archives de la mémoire du projet sont conservées."""
    f = sessions_dir() / f"{sid}.json"
    if f.exists():
        f.unlink()
        return True
    return False


def list_sessions() -> list[Session]:
    out = []
    for p in sessions_dir().glob("*.json"):
        try:
            out.append(Session(**json.loads(p.read_text(encoding="utf-8"))))
        except Exception:
            continue
    return sorted(out, key=lambda s: -s.updated)
