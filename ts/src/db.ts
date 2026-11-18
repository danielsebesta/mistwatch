import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ClientSpend, LedgerInsert, LedgerRow, Snapshot, UsageRow } from "./types.ts";
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL, account TEXT NOT NULL, pool TEXT NOT NULL, client TEXT,
  model TEXT, endpoint TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
  cached_tokens INTEGER, cost_eur REAL NOT NULL, source TEXT NOT NULL,  -- proxy | sync
  estimated INTEGER DEFAULT 0, status INTEGER, latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ledger ON ledger(account, pool, ts);
CREATE INDEX IF NOT EXISTS ix_ledger_ts ON ledger(ts);
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
`;
type Row = Record<string, unknown>;
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new TypeError(`db: expected string, got ${typeof v}`);
  return v;
};
const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new TypeError(`db: expected number, got ${typeof v}`);
};
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const mapSnapshot = (r: Row): Snapshot => ({
  ts: num(r.ts),
  account: str(r.account),
  pool: str(r.pool),
  used_eur: num(r.used_eur),
  initial_eur: num(r.initial_eur),
  reset_at: num(r.reset_at),
  currency: optStr(r.currency),
});
const mapLedgerRow = (r: Row): LedgerRow => ({
  id: num(r.id),
  ts: num(r.ts),
  account: str(r.account),
  pool: str(r.pool),
  client: optStr(r.client),
  model: optStr(r.model),
  endpoint: optStr(r.endpoint),
  prompt_tokens: optNum(r.prompt_tokens),
  completion_tokens: optNum(r.completion_tokens),
  cached_tokens: optNum(r.cached_tokens),
  cost_eur: num(r.cost_eur),
  source: str(r.source),
  estimated: optNum(r.estimated),
  status: optNum(r.status),
  latency_ms: optNum(r.latency_ms),
});
const accClause = (account: string | string[]): [string, string[]] =>
  typeof account === "string"
    ? ["account=?", [account]]
    : [`account IN (${account.map(() => "?").join(",")})`, [...account]];
export const cmpCp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export type CostBetweenOpts = {
  upto?: number | undefined;
  inclusive?: boolean | undefined;
  source?: string | undefined;
};
export type DB = {
  readonly conn: DatabaseSync;
  links: Map<string, string>;
  linksInfo: Map<string, string>;
  stmt(sql: string): StatementSync;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  canonical(account: string): string;
  members(account: string): string[];
  addLedger(row: LedgerInsert): void;
  addSnapshot(s: Snapshot): void;
  latestSnapshot(account: string, pool: string): Snapshot | null;
  costBetween(account: string | string[], pool: string, after: number, opts?: CostBetweenOpts): number;
  rowsSince(account: string | string[], pool: string, since: number): [number, number][];
  sumCost(since: number, until: number): number;
  usageRows(since: number, until: number): UsageRow[];
  recent(limit?: number): LedgerRow[];
  byClientSince(since: number): ClientSpend[];
  tx<T>(fn: () => T): T;
  close(): void;
};
export const openDb = (path: string): DB => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const conn = new DatabaseSync(path);
  conn.exec("PRAGMA journal_mode=WAL");
  conn.exec("PRAGMA busy_timeout=5000");
  conn.exec("PRAGMA foreign_keys=ON");
  conn.exec(SCHEMA);
  const stmts = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    const s = stmts.get(sql);
    if (s !== undefined) return s;
    const n = conn.prepare(sql);
    stmts.set(sql, n);
    return n;
  };
  const one = (sql: string, args: (string | number | null)[]): Row | undefined => stmt(sql).get(...args);
  let inTx = false;
  const db: DB = {
    conn,
    links: new Map(),
    linksInfo: new Map(),
    stmt,
    getMeta: (key) => {
      const r = one("SELECT v FROM meta WHERE k=?", [key]);
      return r ? str(r.v) : null;
    },
    setMeta: (key, value) => {
      stmt("INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key, value);
    },
    canonical: (account) => {
      let cur = account;
      for (let i = 0; i <= db.links.size; i++) {
        const next = db.links.get(cur);
        if (next === undefined || next === account) break;
        cur = next;
      }
      return cur;
    },
    members: (account) => {
      const c = db.canonical(account);
      const rest = [...db.links.keys()].filter((k) => k !== c && db.canonical(k) === c).sort(cmpCp);
      return [c, ...rest];
    },
    addLedger: (r) => {
      stmt(
        "INSERT INTO ledger(ts,account,pool,client,model,endpoint,prompt_tokens,completion_tokens,cached_tokens,cost_eur,source,estimated,status,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        r.ts,
        r.account,
        r.pool,
        r.client ?? null,
        r.model ?? null,
        r.endpoint ?? null,
        r.prompt_tokens ?? null,
        r.completion_tokens ?? null,
        r.cached_tokens ?? null,
        r.cost_eur,
        r.source,
        r.estimated ?? null,
        r.status ?? null,
        r.latency_ms ?? null,
      );
    },
    addSnapshot: (s) => {
      stmt("INSERT INTO snapshots(ts,account,pool,used_eur,initial_eur,reset_at,currency) VALUES(?,?,?,?,?,?,?)").run(
        s.ts,
        s.account,
        s.pool,
        s.used_eur,
        s.initial_eur,
        s.reset_at,
        s.currency,
      );
    },
    latestSnapshot: (account, pool) => {
      const r = one("SELECT * FROM snapshots WHERE account=? AND pool=? ORDER BY ts DESC LIMIT 1", [account, pool]);
      return r ? mapSnapshot(r) : null;
    },
    costBetween: (account, pool, after, opts = {}) => {
      const [clause, accs] = accClause(account);
      let q = `SELECT COALESCE(SUM(cost_eur),0) AS s FROM ledger WHERE ${clause} AND pool=? AND ts${opts.inclusive ? ">=" : ">"}?`;
      const args: (string | number)[] = [...accs, pool, after];
      if (opts.upto != null) {
        q += " AND ts<=?";
        args.push(opts.upto);
      }
      if (opts.source) {
        q += " AND source=?";
        args.push(opts.source);
      }
      const r = one(q, args);
      return num(r?.s ?? 0);
    },
    rowsSince: (account, pool, since) => {
      const [clause, accs] = accClause(account);
      return stmt(`SELECT ts, cost_eur FROM ledger WHERE ${clause} AND pool=? AND ts>=? ORDER BY ts`)
        .all(...accs, pool, since)
        .map((r): [number, number] => [num(r.ts), num(r.cost_eur)]);
    },
    sumCost: (since, until) => {
      const r = one("SELECT COALESCE(SUM(cost_eur),0) s FROM ledger WHERE ts>=? AND ts<?", [since, until]);
      return num(r?.s ?? 0);
    },
    usageRows: (since, until) =>
      stmt("SELECT ts, cost_eur, model, client, account, pool, source FROM ledger WHERE ts>=? AND ts<? ORDER BY ts")
        .all(since, until)
        .map((r) => ({
          ts: num(r.ts),
          cost_eur: num(r.cost_eur),
          model: optStr(r.model),
          client: optStr(r.client),
          account: str(r.account),
          pool: str(r.pool),
          source: str(r.source),
        })),
    recent: (limit = 50) => stmt("SELECT * FROM ledger ORDER BY ts DESC LIMIT ?").all(limit).map(mapLedgerRow),
    byClientSince: (since) =>
      stmt(
        "SELECT COALESCE(client,'-') client, account, pool, COUNT(*) n, SUM(cost_eur) cost_eur FROM ledger WHERE ts>=? AND source='proxy' GROUP BY 1,2,3 ORDER BY cost_eur DESC",
      )
        .all(since)
        .map((r) => ({
          client: str(r.client),
          account: str(r.account),
          pool: str(r.pool),
          n: num(r.n),
          cost_eur: num(r.cost_eur),
        })),
    tx: (fn) => {
      if (inTx) return fn();
      conn.exec("BEGIN IMMEDIATE");
      inTx = true;
      try {
        const r = fn();
        conn.exec("COMMIT");
        return r;
      } catch (e) {
        conn.exec("ROLLBACK");
        throw e;
      } finally {
        inTx = false;
      }
    },
    close: () => {
      conn.close();
    },
  };
  return db;
};
