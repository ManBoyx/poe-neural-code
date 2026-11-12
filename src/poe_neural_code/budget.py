"""Suivi LOCAL des points et tokens, indépendant du connecteur.

Principes :
- Aucune conversion universelle points↔tokens. Les points estimés = USD (prix du modèle × tokens) × taux
  points/USD SAISI PAR L'UTILISATEUR. Sans prix ou sans taux : « estimation indisponible ».
- Chaque valeur porte sa nature : measured (renvoyée par le fournisseur) | estimated | manual | unavailable.
- Ce registre ne contient que ce que CETTE application a dépensé : ce n'est pas l'historique du compte.
- Le renouvellement réinitialise uniquement l'enveloppe locale ; il ne crée aucun point chez le fournisseur.
- Réservations : un coût estimé est réservé avant chaque requête (transaction exclusive SQLite) pour que
  plusieurs tâches ne dépensent pas la même enveloppe.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime

from .paths import data_dir
from .provider.base import ModelInfo

KINDS = ("measured", "estimated", "manual", "unavailable")

SCHEMA = """
CREATE TABLE IF NOT EXISTS envelopes(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'temporary',
  amount_points REAL, token_limit INTEGER, period_s INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT '["*"]', on_exhaust TEXT NOT NULL DEFAULT 'pause', carry_over INTEGER NOT NULL DEFAULT 0,
  carried REAL NOT NULL DEFAULT 0, period_start REAL NOT NULL, period_end REAL,
  last_alert INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, session_id TEXT, model TEXT,
  tokens_in INTEGER, tokens_out INTEGER, tokens_kind TEXT NOT NULL,
  points REAL, points_kind TEXT NOT NULL, usd REAL, note TEXT);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, session_id TEXT, model TEXT, points REAL, tokens INTEGER,
  state TEXT NOT NULL DEFAULT 'held');
"""


class BudgetExhausted(Exception):
    def __init__(self, message: str, envelope: str | None = None):
        super().__init__(message)
        self.envelope = envelope


@dataclass
class Reservation:
    id: int
    points: float | None
    tokens: int | None
    exact_cap_guaranteed: bool
    warnings: list[str] = field(default_factory=list)


@dataclass
class Envelope:
    id: int
    name: str
    kind: str
    amount_points: float | None
    token_limit: int | None
    period_s: int
    scope: list[str]
    on_exhaust: str
    carry_over: bool
    carried: float
    period_start: float
    period_end: float | None
    last_alert: int


def estimate_usd(m: ModelInfo | None, tokens_in: int, tokens_out: int) -> float | None:
    if m is None or m.prompt_price is None or m.completion_price is None:
        return None
    return tokens_in * m.prompt_price + tokens_out * m.completion_price


def usd_to_points(usd: float | None, rate: float | None) -> float | None:
    return None if usd is None or not rate else usd * rate


class Budget:
    def __init__(self, path=None, clock=time.time):
        self.clock = clock
        self.conn = sqlite3.connect(str(path or data_dir() / "budget.db"), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.recover()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def _tx(self):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise

    def recover(self) -> int:
        """Après un arrêt brutal, libère les réservations restées 'held' d'un processus mort."""
        with self._tx() as c:
            return c.execute("UPDATE reservations SET state='released' WHERE state='held'").rowcount

    # ------------------------------------------------------------ enveloppes
    def _row_to_env(self, r) -> Envelope:
        return Envelope(r["id"], r["name"], r["kind"], r["amount_points"], r["token_limit"], r["period_s"],
                        json.loads(r["scope"]), r["on_exhaust"], bool(r["carry_over"]), r["carried"],
                        r["period_start"], r["period_end"], r["last_alert"])

    def set_envelope(self, *, kind: str = "temporary", name: str | None = None, amount_points: float | None,
                     token_limit: int | None = None, period_s: int = 0, scope: list[str] | None = None,
                     on_exhaust: str = "pause", carry_over: bool = False) -> Envelope:
        """Définit (en remplaçant l'actuelle du même type) l'enveloppe 'global' ou 'temporary'."""
        if on_exhaust not in ("pause", "warn"):
            raise ValueError("on_exhaust ∈ pause|warn")
        if amount_points is None and token_limit is None:
            raise ValueError("un montant en points et/ou une limite en tokens est requis")
        now = self.clock()
        with self._tx() as c:
            c.execute("UPDATE envelopes SET active=0 WHERE kind=? AND active=1", (kind,))
            cur = c.execute(
                "INSERT INTO envelopes(name,kind,amount_points,token_limit,period_s,scope,on_exhaust,carry_over,period_start,"
                "period_end,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (name or kind, kind, amount_points, token_limit, period_s, json.dumps(scope or ["*"]), on_exhaust,
                 int(carry_over), now, now + period_s if period_s else None, now))
            return self._row_to_env(c.execute("SELECT * FROM envelopes WHERE id=?", (cur.lastrowid,)).fetchone())

    def clear_envelope(self, kind: str) -> None:
        with self._tx() as c:
            c.execute("UPDATE envelopes SET active=0 WHERE kind=?", (kind,))

    def envelopes(self) -> list[Envelope]:
        """Enveloppes actives, renouvelées si leur échéance est passée (persistant : survit aux redémarrages)."""
        now = self.clock()
        with self._tx() as c:
            for r in c.execute("SELECT * FROM envelopes WHERE active=1").fetchall():
                if r["period_s"] and r["period_end"] and now >= r["period_end"]:
                    e = self._row_to_env(r)
                    left = max(0.0, (e.amount_points or 0) + e.carried - self._spent_points(c, e)) if e.amount_points is not None else 0
                    k = int((now - r["period_end"]) // r["period_s"]) + 1
                    start = r["period_end"] + (k - 1) * r["period_s"]
                    c.execute("UPDATE envelopes SET period_start=?, period_end=?, carried=?, last_alert=0 WHERE id=?",
                              (start, start + r["period_s"], left if e.carry_over else 0.0, r["id"]))
            rows = c.execute("SELECT * FROM envelopes WHERE active=1 ORDER BY id").fetchall()
        return [self._row_to_env(r) for r in rows]

    @staticmethod
    def _in_scope(e: Envelope, model: str | None) -> bool:
        return "*" in e.scope or (model in e.scope) or any(sc.endswith("*") and sc != "*" and (model or "").startswith(sc[:-1]) for sc in e.scope)

    def _spent_points(self, c, e: Envelope) -> float:
        total = 0.0
        for r in c.execute("SELECT model, points FROM ledger WHERE ts>=? AND points IS NOT NULL AND points_kind!='unavailable'",
                           (e.period_start,)):
            if self._in_scope(e, r["model"]):
                total += r["points"]
        return total

    def _spent_tokens(self, c, e: Envelope) -> int:
        total = 0
        for r in c.execute("SELECT model, COALESCE(tokens_in,0)+COALESCE(tokens_out,0) t FROM ledger WHERE ts>=? "
                           "AND tokens_kind!='unavailable'", (e.period_start,)):
            if self._in_scope(e, r["model"]):
                total += r["t"]
        return total

    def _held(self, c, e: Envelope) -> tuple[float, int]:
        p, t = 0.0, 0
        for r in c.execute("SELECT model, points, tokens FROM reservations WHERE state='held'"):
            if self._in_scope(e, r["model"]):
                p += r["points"] or 0
                t += r["tokens"] or 0
        return p, t

    def status(self, e: Envelope) -> dict:
        with self.lock:
            sp, st = self._spent_points(self.conn, e), self._spent_tokens(self.conn, e)
            hp, ht = self._held(self.conn, e)
        pts_total = None if e.amount_points is None else e.amount_points + e.carried
        return {"envelope": e, "spent_points": sp, "spent_tokens": st, "held_points": hp, "held_tokens": ht,
                "total_points": pts_total, "remaining_points": None if pts_total is None else pts_total - sp - hp,
                "remaining_tokens": None if e.token_limit is None else e.token_limit - st - ht,
                "percent": (sp / pts_total * 100) if pts_total else None, "renews_at": e.period_end}

    # ------------------------------------------------------------ réservation
    def reserve(self, session_id: str, model: str, est_points: float | None, est_tokens: int | None,
                bounded: bool) -> Reservation:
        """Réserve le coût estimé. `bounded` = la sortie est plafonnée (max_tokens) donc le coût a un majorant
        (sous réserve que l'estimation d'entrée soit juste). Lève BudgetExhausted si l'enveloppe 'pause' ne suffit pas."""
        self.envelopes()  # applique d'abord les renouvellements
        warnings: list[str] = []
        applicable = False
        with self._tx() as c:
            for r in c.execute("SELECT * FROM envelopes WHERE active=1").fetchall():
                e = self._row_to_env(r)
                if not self._in_scope(e, model):
                    continue
                applicable = True
                hp, ht = self._held(c, e)
                if e.amount_points is not None:
                    left = e.amount_points + e.carried - self._spent_points(c, e) - hp
                    if left <= 0 or (est_points is not None and est_points > left):
                        msg = (f"Budget « {e.name} » épuisé : reste {max(left, 0):.1f} pts"
                               + (f", requête estimée à {est_points:.1f} pts" if est_points is not None else ""))
                        if e.on_exhaust == "pause":
                            raise BudgetExhausted(msg + " — nouvelles requêtes en pause.", e.name)
                        warnings.append(msg + " (comportement : avertir seulement)")
                    elif est_points is None:
                        warnings.append(f"coût en points inestimable : le plafond de « {e.name} » ne peut pas être garanti")
                if e.token_limit is not None:
                    left_t = e.token_limit - self._spent_tokens(c, e) - ht
                    if left_t <= 0 or (est_tokens is not None and est_tokens > left_t):
                        msg = f"Limite de tokens « {e.name} » atteinte (reste {max(left_t, 0)})"
                        if e.on_exhaust == "pause":
                            raise BudgetExhausted(msg + " — nouvelles requêtes en pause.", e.name)
                        warnings.append(msg)
            cur = c.execute("INSERT INTO reservations(ts,session_id,model,points,tokens) VALUES(?,?,?,?,?)",
                            (self.clock(), session_id, model, est_points, est_tokens))
            guaranteed = bounded and est_points is not None
            if not guaranteed and applicable:
                warnings.append("plafond exact non garanti (coût réel non borné ou non estimable à l'avance)")
            return Reservation(cur.lastrowid, est_points, est_tokens, guaranteed, sorted(set(warnings)))

    def release(self, res: Reservation) -> None:
        with self._tx() as c:
            c.execute("UPDATE reservations SET state='released' WHERE id=? AND state='held'", (res.id,))

    def commit(self, res: Reservation | None, *, session_id: str, model: str, tokens_in: int | None,
               tokens_out: int | None, tokens_kind: str, points: float | None, points_kind: str, usd: float | None,
               note: str = "") -> int:
        assert tokens_kind in KINDS and points_kind in KINDS
        with self._tx() as c:
            if res:
                c.execute("UPDATE reservations SET state='committed' WHERE id=?", (res.id,))
            return c.execute("INSERT INTO ledger(ts,session_id,model,tokens_in,tokens_out,tokens_kind,points,points_kind,usd,note) "
                             "VALUES(?,?,?,?,?,?,?,?,?,?)",
                             (self.clock(), session_id, model, tokens_in, tokens_out, tokens_kind, points, points_kind, usd, note)).lastrowid

    def add_manual(self, session_id: str, points: float, model: str | None = None, note: str = "saisie manuelle") -> int:
        return self.commit(None, session_id=session_id, model=model or "-", tokens_in=None, tokens_out=None,
                           tokens_kind="unavailable", points=points, points_kind="manual", usd=None, note=note)

    # ------------------------------------------------------------ alertes
    def pending_alerts(self, thresholds=(50, 75, 90, 100)) -> list[tuple[str, int]]:
        """Paliers franchis non encore notifiés (une fois par palier et par période)."""
        out = []
        for e in self.envelopes():
            if e.amount_points is None:
                continue
            st = self.status(e)
            crossed = [t for t in thresholds if (st["percent"] or 0) >= t]
            if crossed and crossed[-1] > e.last_alert:
                with self._tx() as c:
                    c.execute("UPDATE envelopes SET last_alert=? WHERE id=?", (crossed[-1], e.id))
                out.append((e.name, crossed[-1]))
        return out

    # ------------------------------------------------------------ totaux
    def totals(self, since: float, session_id: str | None = None, model: str | None = None) -> dict:
        q = "SELECT * FROM ledger WHERE ts>=?"
        args: list = [since]
        if session_id:
            q += " AND session_id=?"
            args.append(session_id)
        if model:
            q += " AND model=?"
            args.append(model)
        out = {"points": {k: 0.0 for k in KINDS if k != "unavailable"}, "points_unavailable_requests": 0,
               "tokens_in": {"measured": 0, "estimated": 0}, "tokens_out": {"measured": 0, "estimated": 0}, "requests": 0, "usd": 0.0}
        with self.lock:
            rows = self.conn.execute(q, args).fetchall()
        for r in rows:
            out["requests"] += 1
            out["usd"] += r["usd"] or 0.0
            if r["points_kind"] == "unavailable" or r["points"] is None:
                out["points_unavailable_requests"] += 1
            else:
                out["points"][r["points_kind"]] += r["points"]
            if r["tokens_kind"] in ("measured", "estimated"):
                out["tokens_in"][r["tokens_kind"]] += r["tokens_in"] or 0
                out["tokens_out"][r["tokens_kind"]] += r["tokens_out"] or 0
        return out

    def by_model(self, since: float) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("SELECT model, COUNT(*) n, SUM(CASE WHEN points_kind!='unavailable' THEN points END) p "
                                     "FROM ledger WHERE ts>=? GROUP BY model ORDER BY p DESC", (since,)).fetchall()
        return [dict(r) for r in rows]

    def by_model_detail(self, since: float) -> list[dict]:
        """Détail par modèle/agent : requêtes, tokens (mesurés/estimés séparés), USD, points par nature. Rien n'est additionné entre natures."""
        with self.lock:
            rows = self.conn.execute("SELECT * FROM ledger WHERE ts>=?", (since,)).fetchall()
        out: dict[str, dict] = {}
        for r in rows:
            d = out.setdefault(r["model"] or "-", {"model": r["model"] or "-", "requests": 0, "tin": {"measured": 0, "estimated": 0},
                                                   "tout": {"measured": 0, "estimated": 0}, "usd": 0.0, "points": {"estimated": 0.0, "manual": 0.0, "measured": 0.0}})
            d["requests"] += 1
            if r["tokens_kind"] in ("measured", "estimated"):
                d["tin"][r["tokens_kind"]] += r["tokens_in"] or 0
                d["tout"][r["tokens_kind"]] += r["tokens_out"] or 0
            d["usd"] += r["usd"] or 0.0
            if r["points"] is not None and r["points_kind"] in d["points"]:
                d["points"][r["points_kind"]] += r["points"]
        return sorted(out.values(), key=lambda d: -(sum(d["tin"].values()) + sum(d["tout"].values())))

    def tokens_equivalent(self, remaining_points: float | None, m: ModelInfo | None, rate: float | None) -> tuple[float, float] | None:
        """Fourchette de tokens qu'achèteraient les points restants : (tout en sortie, tout en entrée).
        None (« estimation indisponible ») sans prix du modèle ou sans taux saisi. Hors conditions de cache."""
        if remaining_points is None or not rate or m is None or not m.prompt_price or not m.completion_price:
            return None
        usd = max(remaining_points, 0) / rate
        return usd / m.completion_price, usd / m.prompt_price


def day_start(now: float) -> float:
    return datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def week_start(now: float) -> float:
    d = datetime.fromtimestamp(day_start(now))
    return (d - __import__("datetime").timedelta(days=d.weekday())).timestamp()


def month_start(now: float) -> float:
    return datetime.fromtimestamp(now).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
