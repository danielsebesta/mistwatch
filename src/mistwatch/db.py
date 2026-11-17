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
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS model_names(model_id TEXT PRIMARY KEY, display TEXT NOT NULL);  -- your own overrides
CREATE TABLE IF NOT EXISTS model_catalog(  -- cached /v1/models: display name + aliases per model id
  model_id TEXT PRIMARY KEY, name TEXT, aliases TEXT, description TEXT
);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created REAL NOT NULL, last_seen REAL NOT NULL, expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys(  -- keys local tools use against the proxy; only the hash is kept
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE, created REAL NOT NULL, last_used REAL
);
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1, keys TEXT NOT NULL DEFAULT '{}',  -- {pool: secret reference}
  manual TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL
);
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
        # Accounts that turned out to share one Mistral budget: member -> canonical account (see groups.py).
        self.links: dict[str, str] = {}
        self.links_info: dict[str, str] = {}  # member -> "sure" | "likely"
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.executescript(SCHEMA)

    def get_meta(self, key: str) -> str | None:
        with self.lock:
            r = self.conn.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
        return r[0] if r else None

    def set_meta(self, key: str, value: str) -> None:
        with self.lock:
            self.conn.execute("INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (key, value))
            self.conn.commit()

    def canonical(self, account: str) -> str:
        return self.links.get(account, account)

    def members(self, account: str) -> list[str]:
        """All accounts sharing this account's budget (canonical first)."""
        c = self.canonical(account)
        return [c] + sorted(k for k, v in self.links.items() if v == c and k != c)

    @staticmethod
    def _acc(account: str | list[str]) -> tuple[str, list]:
        if isinstance(account, str):
            return "account=?", [account]
        return f"account IN ({','.join('?' * len(account))})", list(account)

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

    def cost_between(self, account: str | list[str], pool: str, after: float, upto: float | None = None,
                     inclusive: bool = False, source: str | None = None) -> float:
        op = ">=" if inclusive else ">"
        clause, accs = self._acc(account)
        q = f"SELECT COALESCE(SUM(cost_eur),0) FROM ledger WHERE {clause} AND pool=? AND ts{op}?"
        args: list = [*accs, pool, after]
        if upto is not None:
            q += " AND ts<=?"
            args.append(upto)
        if source:
            q += " AND source=?"
            args.append(source)
        with self.lock:
            return float(self.conn.execute(q, args).fetchone()[0])

    def rows_since(self, account: str | list[str], pool: str, since: float) -> list[tuple[float, float]]:
        clause, accs = self._acc(account)
        with self.lock:
            rs = self.conn.execute(
                f"SELECT ts, cost_eur FROM ledger WHERE {clause} AND pool=? AND ts>=? ORDER BY ts",
                (*accs, pool, since),
            ).fetchall()
        return [(r["ts"], r["cost_eur"]) for r in rs]

    def usage_rows(self, since: float, until: float) -> list[dict]:
        with self.lock:
            rs = self.conn.execute(
                "SELECT ts, cost_eur, model, client, account, pool, source FROM ledger WHERE ts>=? AND ts<? ORDER BY ts",
                (since, until)).fetchall()
        return [dict(r) for r in rs]

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
