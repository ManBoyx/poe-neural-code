"""Neural Memory Engine — mémoire EXTERNE structurée (ce n'est pas une modification du modèle).

Organisation : district (projet/sujet) → départements (decisions, knowledge, tasks, summaries, archive)
→ discussions. Quatre couches :
  1. active     : ce que `build_context` sélectionne pour le travail immédiat (jamais tout le stockage)
  2. structured : table `items` (objectifs, contraintes, faits, hypothèses, décisions, tâches, erreurs, questions)
  3. compacted  : table `summaries` (segment → département → district), vérifiables contre les sources
  4. archive    : table `archive`, échanges originaux immuables (triggers SQL interdisant UPDATE/DELETE)

À ne pas confondre : stockage persistant (ce fichier) ≠ cache de travail (`WorkingCache`) ≠ contexte réellement
transmis au modèle (ContextPack) ≠ éventuel cache côté fournisseur (hors de notre contrôle).
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..paths import data_dir

SCHEMA = """
CREATE TABLE IF NOT EXISTS districts(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, path TEXT, description TEXT DEFAULT '', created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS departments(id INTEGER PRIMARY KEY, district_id INTEGER NOT NULL REFERENCES districts(id),
  name TEXT NOT NULL, kind TEXT NOT NULL, UNIQUE(district_id,name));
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, district_id INTEGER NOT NULL REFERENCES districts(id),
  title TEXT, created REAL NOT NULL, compacted_upto INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS archive(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT DEFAULT '{}', ts REAL NOT NULL, sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS archive_no_update BEFORE UPDATE ON archive BEGIN SELECT RAISE(ABORT,'archive immuable'); END;
CREATE TRIGGER IF NOT EXISTS archive_no_delete BEFORE DELETE ON archive BEGIN SELECT RAISE(ABORT,'archive immuable'); END;
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, district_id INTEGER NOT NULL REFERENCES districts(id),
  department_id INTEGER REFERENCES departments(id), kind TEXT NOT NULL, key TEXT, content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', rationale TEXT DEFAULT '', replaces_id INTEGER, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS item_sources(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
  archive_id INTEGER REFERENCES archive(id), file_path TEXT, quote TEXT);
CREATE TABLE IF NOT EXISTS contradictions(id INTEGER PRIMARY KEY, district_id INTEGER NOT NULL, item_a INTEGER NOT NULL,
  item_b INTEGER NOT NULL, detected REAL NOT NULL, status TEXT NOT NULL DEFAULT 'open', note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS summaries(id INTEGER PRIMARY KEY, district_id INTEGER NOT NULL, department_id INTEGER,
  conversation_id INTEGER, level TEXT NOT NULL, content TEXT NOT NULL, from_archive_id INTEGER, to_archive_id INTEGER,
  source_summary_ids TEXT DEFAULT '[]', source_item_ids TEXT DEFAULT '[]', method TEXT NOT NULL, created REAL NOT NULL,
  verified_ok INTEGER, verified_at REAL, supersedes_id INTEGER);
CREATE TABLE IF NOT EXISTS undone(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, ts REAL NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(content, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(content, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(content, tokenize='unicode61 remove_diacritics 2');
"""

ITEM_KINDS = ("goal", "constraint", "fact", "hypothesis", "decision", "task", "error", "question", "file")
DEFAULT_DEPARTMENTS = {"decisions": "decision", "knowledge": "fact", "tasks": "task", "summaries": "summary", "archive": "archive"}
KIND_TO_DEPT = {"decision": "decisions", "constraint": "decisions", "goal": "decisions", "fact": "knowledge",
                "hypothesis": "knowledge", "file": "knowledge", "error": "knowledge", "question": "knowledge", "task": "tasks"}
CONTRADICTABLE = ("fact", "decision", "constraint")


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def fts_query(q: str) -> str:
    words = re.findall(r"\w+", q, flags=re.UNICODE)
    return " ".join(f'"{w}"' for w in words[:12])


@dataclass
class Hit:
    ref: str  # "archive:12" | "item:4" | "summary:3"
    layer: str
    text: str
    district_id: int | None = None
    conversation_id: int | None = None
    ts: float | None = None
    kind: str | None = None


class Memory:
    def __init__(self, path: Path | str | None = None):
        self.path = str(path or data_dir() / "memory.db")
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(items)")}
        if "pinned" not in cols:  # migration douce des bases existantes
            self.conn.execute("ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
            self.conn.commit()
        self.lock = threading.RLock()

    def close(self) -> None:
        self.conn.close()

    # --- helpers ----------------------------------------------------------
    def q(self, sql: str, args=()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def one(self, sql: str, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchone()

    def _w(self, sql: str, args=()) -> int:
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid or 0

    # --- districts / départements / discussions ---------------------------
    def ensure_district(self, name: str, path: str | None = None, description: str = "") -> int:
        r = self.one("SELECT id FROM districts WHERE name=?", (name,))
        if r:
            return r["id"]
        did = self._w("INSERT INTO districts(name,path,description,created) VALUES(?,?,?,?)", (name, path, description, time.time()))
        for dn, kind in DEFAULT_DEPARTMENTS.items():
            self._w("INSERT OR IGNORE INTO departments(district_id,name,kind) VALUES(?,?,?)", (did, dn, kind))
        return did

    def add_department(self, district_id: int, name: str, kind: str = "custom") -> int:
        self._w("INSERT OR IGNORE INTO departments(district_id,name,kind) VALUES(?,?,?)", (district_id, name, kind))
        return self.one("SELECT id FROM departments WHERE district_id=? AND name=?", (district_id, name))["id"]

    def department_id(self, district_id: int, name: str) -> int:
        return self.add_department(district_id, name)

    def districts(self) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM districts ORDER BY name")

    def new_conversation(self, district_id: int, title: str = "") -> int:
        return self._w("INSERT INTO conversations(district_id,title,created) VALUES(?,?,?)", (district_id, title, time.time()))

    def conversations(self, district_id: int) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM conversations WHERE district_id=? ORDER BY id DESC", (district_id,))

    # --- archive (couche 4) ----------------------------------------------
    def archive_message(self, conversation_id: int, role: str, content: str, meta: dict | None = None) -> int:
        with self.lock:
            seq = (self.conn.execute("SELECT COALESCE(MAX(seq),0)+1 s FROM archive WHERE conversation_id=?", (conversation_id,)).fetchone()["s"])
            cur = self.conn.execute("INSERT INTO archive(conversation_id,seq,role,content,meta,ts,sha256) VALUES(?,?,?,?,?,?,?)",
                                    (conversation_id, seq, role, content, json.dumps(meta or {}), time.time(),
                                     hashlib.sha256(content.encode()).hexdigest()))
            self.conn.execute("INSERT INTO archive_fts(rowid,content) VALUES(?,?)", (cur.lastrowid, content))
            self.conn.commit()
            return cur.lastrowid

    def archive_rows(self, conversation_id: int, after_id: int = 0, upto_id: int | None = None) -> list[sqlite3.Row]:
        q = "SELECT * FROM archive WHERE conversation_id=? AND id>? AND NOT EXISTS (SELECT 1 FROM undone u WHERE u.active=1 AND archive.id BETWEEN u.from_id AND u.to_id)"
        a: list[Any] = [conversation_id, after_id]
        if upto_id is not None:
            q += " AND id<=?"
            a.append(upto_id)
        return self.q(q + " ORDER BY id", a)

    def mark_undone(self, conversation_id: int, from_id: int, to_id: int) -> int:
        """Masque une plage (annulation) SANS rien supprimer : l'archive intégrale reste intacte et la plage peut être rétablie."""
        return self._w("INSERT INTO undone(conversation_id,from_id,to_id,ts) VALUES(?,?,?,?)", (conversation_id, from_id, to_id, time.time()))

    def unmark_undone(self, undo_id: int) -> None:
        self._w("UPDATE undone SET active=0 WHERE id=?", (undo_id,))

    def last_archive_id(self, conversation_id: int) -> int:
        r = self.one("SELECT COALESCE(MAX(id),0) m FROM archive WHERE conversation_id=?", (conversation_id,))
        return r["m"]

    # --- items (couche 2) -------------------------------------------------
    def add_item(self, district_id: int, kind: str, content: str, *, key: str | None = None, sources: list[dict] | None = None,
                 rationale: str = "", replaces: int | None = None, status: str = "active") -> tuple[int, int | None]:
        """Ajoute une information structurée avec provenance. Retourne (item_id, contradiction_id|None).

        - `replaces=ID` : mise à jour volontaire ; l'ancien item passe 'superseded' (historique conservé).
        - même (kind,key) actif avec contenu différent, sans `replaces` : CONTRADICTION — les deux sont conservés,
          l'ancien passe 'contradicted' et une contradiction ouverte est enregistrée (jamais d'écrasement silencieux).
        """
        if kind not in ITEM_KINDS:
            raise ValueError(f"kind ∈ {ITEM_KINDS}")
        dept = self.department_id(district_id, KIND_TO_DEPT[kind])
        contradiction = None
        with self.lock:
            if not replaces:
                # Doublon exact (même type, même texte normalisé, encore actif) : on renvoie la note existante.
                # Un doublon serait réinjecté à chaque tour pour rien (coût en tokens).
                for o in self.conn.execute("SELECT id, content FROM items WHERE district_id=? AND kind=? AND status='active'",
                                           (district_id, kind)).fetchall():
                    if _norm(o["content"]) == _norm(content):
                        return o["id"], None
            if replaces:
                self.conn.execute("UPDATE items SET status='superseded' WHERE id=?", (replaces,))
            elif key and kind in CONTRADICTABLE:
                old = self.conn.execute("SELECT * FROM items WHERE district_id=? AND kind=? AND key=? AND status='active'",
                                        (district_id, kind, key)).fetchall()
                old = [o for o in old if _norm(o["content"]) != _norm(content)]
            else:
                old = []
            cur = self.conn.execute("INSERT INTO items(district_id,department_id,kind,key,content,status,rationale,replaces_id,created) "
                                    "VALUES(?,?,?,?,?,?,?,?,?)", (district_id, dept, kind, key, content, status, rationale, replaces, time.time()))
            iid = cur.lastrowid
            self.conn.execute("INSERT INTO items_fts(rowid,content) VALUES(?,?)", (iid, f"{key or ''} {content} {rationale}"))
            for s in sources or []:
                self.conn.execute("INSERT INTO item_sources(item_id,archive_id,file_path,quote) VALUES(?,?,?,?)",
                                  (iid, s.get("archive_id"), s.get("file_path"), s.get("quote")))
            if not replaces and key and kind in CONTRADICTABLE and old:
                for o in old:
                    self.conn.execute("UPDATE items SET status='contradicted' WHERE id=?", (o["id"],))
                    contradiction = self.conn.execute(
                        "INSERT INTO contradictions(district_id,item_a,item_b,detected,note) VALUES(?,?,?,?,?)",
                        (district_id, o["id"], iid, time.time(), f"clé « {key} » : valeurs différentes")).lastrowid
            self.conn.commit()
        return iid, contradiction

    MAX_PINNED = 40

    def set_pinned(self, item_id: int, pinned: bool) -> None:
        """Une note épinglée est TOUJOURS fournie au modèle (hors budget), dans la limite de MAX_PINNED notes."""
        with self.lock:
            if pinned:
                row = self.conn.execute("SELECT district_id FROM items WHERE id=?", (item_id,)).fetchone()
                n = self.conn.execute("SELECT COUNT(*) FROM items WHERE district_id=? AND pinned=1 AND status='active'",
                                      (row["district_id"],)).fetchone()[0] if row else 0
                if n >= self.MAX_PINNED:
                    raise ValueError(f"au plus {self.MAX_PINNED} notes épinglées par dossier")
            self.conn.execute("UPDATE items SET pinned=? WHERE id=?", (1 if pinned else 0, item_id))
            self.conn.commit()

    def edit_item(self, item_id: int, content: str) -> int:
        """Nouvelle version d'une note (l'ancienne passe 'superseded', historique conservé) ; l'épinglage est conservé."""
        old = self.one("SELECT * FROM items WHERE id=?", (item_id,))
        if old is None:
            raise KeyError(item_id)
        if old["content"].strip() == content.strip():
            return item_id
        new_id, _ = self.add_item(old["district_id"], old["kind"], content.strip(), key=old["key"], replaces=item_id,
                                  rationale=old["rationale"] or "")
        if old["pinned"]:
            with self.lock:
                self.conn.execute("UPDATE items SET pinned=1 WHERE id=?", (new_id,))
                self.conn.commit()
        return new_id

    def set_item_status(self, item_id: int, status: str) -> None:
        self._w("UPDATE items SET status=? WHERE id=?", (status, item_id))

    def items(self, district_id: int, kinds=None, statuses=("active",)) -> list[sqlite3.Row]:
        q = "SELECT * FROM items WHERE district_id=?"
        a: list[Any] = [district_id]
        if kinds:
            q += f" AND kind IN ({','.join('?' * len(kinds))})"
            a += list(kinds)
        if statuses:
            q += f" AND status IN ({','.join('?' * len(statuses))})"
            a += list(statuses)
        return self.q(q + " ORDER BY id", a)

    def item_sources(self, item_id: int) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM item_sources WHERE item_id=?", (item_id,))

    def open_contradictions(self, district_id: int) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM contradictions WHERE district_id=? AND status='open'", (district_id,))

    def resolve_contradiction(self, cid: int, note: str, keep_item: int | None = None) -> None:
        r = self.one("SELECT * FROM contradictions WHERE id=?", (cid,))
        if not r:
            return
        self._w("UPDATE contradictions SET status='resolved', note=? WHERE id=?", (note, cid))
        if keep_item:
            other = r["item_a"] if keep_item == r["item_b"] else r["item_b"]
            self.set_item_status(keep_item, "active")
            self.set_item_status(other, "superseded")

    # --- recherche --------------------------------------------------------
    def search(self, query: str, *, district_id: int | None = None, conversation_id: int | None = None,
               kinds: list[str] | None = None, layers=("items", "summaries", "archive"), since: float | None = None,
               until: float | None = None, limit: int = 10) -> list[Hit]:
        """Recherche textuelle (FTS5) avec filtres projet/discussion/date/type. Retourne des références exactes."""
        fq = fts_query(query)
        if not fq:
            return []
        hits: list[Hit] = []
        if "items" in layers:
            sql = ("SELECT i.id, i.kind, i.content, i.key, i.created, i.district_id, i.status FROM items_fts f JOIN items i ON i.id=f.rowid "
                   "WHERE items_fts MATCH ?")
            a: list[Any] = [fq]
            if district_id:
                sql += " AND i.district_id=?"
                a.append(district_id)
            if kinds:
                sql += f" AND i.kind IN ({','.join('?' * len(kinds))})"
                a += kinds
            if since:
                sql += " AND i.created>=?"
                a.append(since)
            if until:
                sql += " AND i.created<=?"
                a.append(until)
            for r in self.q(sql + " ORDER BY rank LIMIT ?", a + [limit]):
                hits.append(Hit(f"item:{r['id']}", "structured", f"[{r['kind']}/{r['status']}] {r['content']}", r["district_id"], None, r["created"], r["kind"]))
        if "summaries" in layers:
            sql = "SELECT s.* FROM summaries_fts f JOIN summaries s ON s.id=f.rowid WHERE summaries_fts MATCH ?"
            a = [fq]
            if district_id:
                sql += " AND s.district_id=?"
                a.append(district_id)
            if conversation_id:
                sql += " AND s.conversation_id=?"
                a.append(conversation_id)
            if since:
                sql += " AND s.created>=?"
                a.append(since)
            if until:
                sql += " AND s.created<=?"
                a.append(until)
            for r in self.q(sql + " ORDER BY rank LIMIT ?", a + [limit]):
                hits.append(Hit(f"summary:{r['id']}", "compacted", f"[{r['level']}] {r['content'][:400]}", r["district_id"], r["conversation_id"], r["created"], r["level"]))
        if "archive" in layers:
            sql = ("SELECT a.id, a.role, a.content, a.ts, a.conversation_id, c.district_id FROM archive_fts f JOIN archive a ON a.id=f.rowid "
                   "JOIN conversations c ON c.id=a.conversation_id WHERE archive_fts MATCH ? AND NOT EXISTS "
                   "(SELECT 1 FROM undone u WHERE u.active=1 AND a.id BETWEEN u.from_id AND u.to_id)")
            a = [fq]
            if district_id:
                sql += " AND c.district_id=?"
                a.append(district_id)
            if conversation_id:
                sql += " AND a.conversation_id=?"
                a.append(conversation_id)
            if kinds:
                sql += f" AND a.role IN ({','.join('?' * len(kinds))})"
                a += kinds
            if since:
                sql += " AND a.ts>=?"
                a.append(since)
            if until:
                sql += " AND a.ts<=?"
                a.append(until)
            for r in self.q(sql + " ORDER BY rank LIMIT ?", a + [limit]):
                hits.append(Hit(f"archive:{r['id']}", "archive", f"[{r['role']}] {r['content'][:400]}", r["district_id"], r["conversation_id"], r["ts"], r["role"]))
        return hits[: limit * 2]

    def load_passage(self, archive_id: int, before: int = 2, after: int = 2) -> list[sqlite3.Row]:
        r = self.one("SELECT conversation_id, seq FROM archive WHERE id=?", (archive_id,))
        if not r:
            return []
        return self.q("SELECT * FROM archive WHERE conversation_id=? AND seq BETWEEN ? AND ? ORDER BY seq",
                      (r["conversation_id"], r["seq"] - before, r["seq"] + after))

    def resolve_ref(self, ref: str) -> str | None:
        kind, _, n = ref.partition(":")
        if not n.isdigit():
            return None
        if kind == "archive":
            r = self.one("SELECT role, content FROM archive WHERE id=?", (int(n),))
            return f"[{r['role']}] {r['content']}" if r else None
        if kind == "item":
            r = self.one("SELECT * FROM items WHERE id=?", (int(n),))
            return f"[{r['kind']}/{r['status']}] {r['content']}" if r else None
        if kind == "summary":
            r = self.one("SELECT * FROM summaries WHERE id=?", (int(n),))
            return r["content"] if r else None
        return None

    # --- résumés (couche 3) : stockage ------------------------------------
    def add_summary(self, district_id: int, level: str, content: str, *, department_id: int | None = None,
                    conversation_id: int | None = None, from_archive_id: int | None = None, to_archive_id: int | None = None,
                    source_summary_ids: list[int] | None = None, source_item_ids: list[int] | None = None, method: str = "extractive") -> int:
        with self.lock:
            prev = self.conn.execute("SELECT id FROM summaries WHERE district_id=? AND level=? AND COALESCE(department_id,0)=COALESCE(?,0) "
                                     "AND COALESCE(conversation_id,0)=COALESCE(?,0) ORDER BY id DESC LIMIT 1",
                                     (district_id, level, department_id, conversation_id if level == "segment" else None)).fetchone()
            cur = self.conn.execute(
                "INSERT INTO summaries(district_id,department_id,conversation_id,level,content,from_archive_id,to_archive_id,"
                "source_summary_ids,source_item_ids,method,created,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (district_id, department_id, conversation_id, level, content, from_archive_id, to_archive_id,
                 json.dumps(source_summary_ids or []), json.dumps(source_item_ids or []), method, time.time(),
                 prev["id"] if prev and level != "segment" else None))
            self.conn.execute("INSERT INTO summaries_fts(rowid,content) VALUES(?,?)", (cur.lastrowid, content))
            self.conn.commit()
            return cur.lastrowid
