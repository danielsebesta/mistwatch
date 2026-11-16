"""SQLite ledger: every proxied request + periodic snapshots of Mistral's own budget counters."""
from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL, account TEXT NOT NULL, pool TEXT NOT NULL, client TEXT,
  model TEXT, endpoint TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
  cached_tokens INTEGER, cost_eur REAL NOT NULL, source TEXT NOT NULL,  -- proxy | sync
  estimated INTEGER DEFAULT 0, status INTEGER, latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ledger ON ledger(account, pool, ts);
CREATE TABLE IF NOT EXISTS snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL, account TEXT NOT NULL, pool TEXT NOT NULL,
  used_eur REAL NOT NULL, initial_eur REAL NOT NULL, reset_at REAL NOT NULL, currency TEXT
);
CREATE INDEX IF NOT EXISTS ix_snap ON snapshots(account, pool, ts);
"""


@dataclass
class Snapshot:
    ts: float
    account: str
    pool: str
    used_eur: float
    initial_eur: float
    reset_at: float
    currency: str | None = None


class DB:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.executescript(SCHEMA)

    def add_ledger(self, **r) -> None:
        cols = (
            "ts account pool client model endpoint prompt_tokens completion_tokens "
            "cached_tokens cost_eur source estimated status latency_ms"
        ).split()
        with self.lock:
            self.conn.execute(
                f"INSERT INTO ledger({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                [r.get(c) for c in cols],
            )
            self.conn.commit()

    def add_snapshot(self, s: Snapshot) -> None:
        with self.lock:
            self.conn.execute(
                "INSERT INTO snapshots(ts,account,pool,used_eur,initial_eur,reset_at,currency) VALUES(?,?,?,?,?,?,?)",
                (s.ts, s.account, s.pool, s.used_eur, s.initial_eur, s.reset_at, s.currency),
            )
            self.conn.commit()

    def latest_snapshot(self, account: str, pool: str) -> Snapshot | None:
        with self.lock:
            r = self.conn.execute(
                "SELECT * FROM snapshots WHERE account=? AND pool=? ORDER BY ts DESC LIMIT 1",
                (account, pool),
            ).fetchone()
        return Snapshot(**{k: r[k] for k in r.keys() if k != "id"}) if r else None

    def cost_between(self, account: str, pool: str, after: float, upto: float | None = None,
                     inclusive: bool = False, source: str | None = None) -> float:
        op = ">=" if inclusive else ">"
        q = f"SELECT COALESCE(SUM(cost_eur),0) FROM ledger WHERE account=? AND pool=? AND ts{op}?"
        args: list = [account, pool, after]
        if upto is not None:
            q += " AND ts<=?"
            args.append(upto)
        if source:
            q += " AND source=?"
            args.append(source)
        with self.lock:
            return float(self.conn.execute(q, args).fetchone()[0])

    def rows_since(self, account: str, pool: str, since: float) -> list[tuple[float, float]]:
        with self.lock:
            rs = self.conn.execute(
                "SELECT ts, cost_eur FROM ledger WHERE account=? AND pool=? AND ts>=? ORDER BY ts",
                (account, pool, since),
            ).fetchall()
        return [(r["ts"], r["cost_eur"]) for r in rs]

    def recent(self, limit: int = 50) -> list[dict]:
        with self.lock:
            rs = self.conn.execute("SELECT * FROM ledger ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rs]

    def by_client_since(self, since: float) -> list[dict]:
        with self.lock:
            rs = self.conn.execute(
                "SELECT COALESCE(client,'-') client, account, pool, COUNT(*) n, SUM(cost_eur) cost_eur "
                "FROM ledger WHERE ts>=? AND source='proxy' GROUP BY 1,2,3 ORDER BY cost_eur DESC",
                (since,),
            ).fetchall()
        return [dict(r) for r in rs]
