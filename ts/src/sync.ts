import type { KeyCheckResponse, Pool, SyncAllResult, SyncedPools, SyncPoolResult } from "../shared/api.ts";
import { keyFor } from "./config.ts";
import type { DB } from "./db.ts";
import { refreshLinks } from "./groups.ts";
import type { State } from "./state.ts";
import type { Account, Config, FetchLike } from "./types.ts";
export const USER_AGENT = "mistwatch/0.1";
const BUDGET_POOLS: Record<string, Pool> = { vibe_budget: "vibe", api_budget: "api" };
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asFloat = (v: unknown): number => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v.trim()))) return Number(v.trim());
  throw new TypeError(`float() argument must be a number or numeric string, not ${typeof v}`);
};
const errName = (e: unknown): string => (e instanceof Error ? e.name : "Error");
type StatusError = Error & { status: number };
const statusError = (status: number): StatusError => Object.assign(new Error(`HTTP ${status}`), { status });
const isStatusError = (e: unknown): e is StatusError =>
  e instanceof Error && "status" in e && typeof e.status === "number";
export const parseIso = (s: string): number => {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new TypeError(`invalid iso timestamp: ${s}`);
  return t / 1000;
};
const daysInMonth = (y: number, m0: number): number => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
export const nextReset = (resetDay: number, now: number): number => {
  const d = new Date(now * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let cand = Date.UTC(y, m, Math.min(resetDay, daysInMonth(y, m))) / 1000;
  if (cand <= now) {
    if (m === 11) {
      y += 1;
      m = 0;
    } else {
      m += 1;
    }
    cand = Date.UTC(y, m, Math.min(resetDay, daysInMonth(y, m))) / 1000;
  }
  return cand;
};
const prevMonth = (ts: number): number => {
  const d = new Date(ts * 1000);
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 0 ? 11 : d.getUTCMonth() - 1;
  return Date.UTC(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m))) / 1000;
};
const fetchBudgetKey = async (fetchFn: FetchLike, base: string, key: string): Promise<Record<string, unknown>> => {
  const r = await fetchFn(`${base}/v1/billing/budget`, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw statusError(r.status);
  const data: unknown = await r.json();
  if (!isRec(data)) throw new TypeError("budget payload is not an object");
  return data;
};
const fetchBudget = async (fetchFn: FetchLike, cfg: Config, acct: Account): Promise<Record<string, unknown>> => {
  let err: unknown = new Error(`account ${acct.name} has no keys configured`);
  const pools = Object.keys(acct.keys).sort((a, b) => (a === "vibe" ? 0 : 1) - (b === "vibe" ? 0 : 1));
  for (const pool of pools) {
    try {
      return await fetchBudgetKey(fetchFn, cfg.upstream, keyFor(acct, pool) ?? "");
    } catch (e) {
      err = e;
    }
  }
  throw err;
};
export const checkKey = async (fetchFn: FetchLike, base: string, key: string): Promise<KeyCheckResponse> => {
  try {
    const data = await fetchBudgetKey(fetchFn, base, key);
    const budgets: KeyCheckResponse["budgets"] = {};
    for (const [fname, pool] of Object.entries(BUDGET_POOLS)) {
      const b = data[fname];
      if (!isRec(b) || Object.keys(b).length === 0) continue;
      const initial = asFloat(b.initial_budget);
      budgets[pool] = {
        initial,
        used: (asFloat(b.usage_percentage) / 100) * initial,
        currency: typeof b.currency === "string" ? b.currency : null,
      };
    }
    return { valid: true, budgets };
  } catch (e) {
    if (isStatusError(e)) {
      if (e.status === 401 || e.status === 403) {
        try {
          const r = await fetchFn(`${base}/v1/models`, {
            headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(15_000),
          });
          if (r.status === 200)
            return { valid: true, budgets: {}, note: "The key works, but it cannot read the budget overview." };
        } catch {
          // a failed model list proves nothing either way: report the original rejection
        }
        return { valid: false, error: `Mistral rejected the key (${e.status}).` };
      }
      return { valid: false, error: `Mistral returned an error (${e.status}).` };
    }
    return { valid: false, error: `Could not reach Mistral: ${errName(e)}` };
  }
};
const recordSnapshot = (
  db: DB,
  account: string,
  pool: string,
  used: number,
  initial: number,
  resetAt: number,
  currency: string | null,
  now: number,
): void => {
  const prev = db.latestSnapshot(account, pool);
  if (prev && Math.abs(prev.reset_at - resetAt) < 1 && now > prev.ts && db.canonical(account) === account) {
    const delta = used - prev.used_eur;
    const seen = db.costBetween(db.members(account), pool, prev.ts, { upto: now });
    const gap = delta - seen;
    if (gap > 0.0005)
      db.addLedger({
        ts: now,
        account,
        pool,
        client: "(external)",
        model: null,
        endpoint: "sync",
        cost_eur: gap,
        source: "sync",
        estimated: 1,
      });
  }
  db.addSnapshot({ ts: now, account, pool, used_eur: used, initial_eur: initial, reset_at: resetAt, currency });
};
const syncAccount = async (fetchFn: FetchLike, cfg: Config, db: DB, acct: Account): Promise<SyncedPools> => {
  const out: Record<string, SyncPoolResult> = {};
  let data: Record<string, unknown> | null = null;
  // snapshot is stamped at request start: bookings made while the fetch is in flight stay on top of it
  const now = Date.now() / 1000;
  try {
    data = await fetchBudget(fetchFn, cfg, acct);
  } catch (e) {
    console.warn(`budget sync failed for ${acct.name}:`, e);
  }
  if (data !== null && Object.keys(data).length > 0) {
    for (const [fname, pool] of Object.entries(BUDGET_POOLS)) {
      const b = data[fname];
      if (!isRec(b) || Object.keys(b).length === 0) continue;
      const initial = asFloat(b.initial_budget);
      const used = (asFloat(b.usage_percentage) / 100) * initial;
      const resetAt = typeof b.reset_at === "string" && b.reset_at ? parseIso(b.reset_at) : nextReset(1, now);
      recordSnapshot(
        db,
        acct.name,
        pool,
        used,
        initial,
        resetAt,
        typeof b.currency === "string" ? b.currency : null,
        now,
      );
      out[pool] = { used, initial, source: "mistral" };
    }
  } else {
    for (const [pool, m] of Object.entries(acct.manual)) {
      const initial = asFloat(m.initial_eur);
      const resetAt = nextReset(Math.trunc(asFloat(m.reset_day ?? 1)), now);
      const used = db.costBetween(acct.name, pool, prevMonth(resetAt), { inclusive: true, upto: now });
      db.addSnapshot({
        ts: now,
        account: acct.name,
        pool,
        used_eur: used,
        initial_eur: initial,
        reset_at: resetAt,
        currency: "EUR",
      });
      out[pool] = { used, initial, source: "manual" };
    }
  }
  return out;
};
export const syncAll = async (fetchFn: FetchLike, cfg: Config, db: DB): Promise<SyncAllResult> => {
  const res: [string, SyncedPools][] = [];
  for (const a of cfg.accounts) {
    if (a.enabled) res.push([a.name, await syncAccount(fetchFn, cfg, db, a)]);
  }
  refreshLinks(
    db,
    cfg.accounts.filter((a) => a.enabled),
  );
  return Object.fromEntries(res);
};
export const startSyncLoop = (st: State): (() => void) => {
  let stopped = false;
  let wake: (() => void) | undefined;
  const tick = async (): Promise<void> => {
    while (!stopped) {
      try {
        await syncAll(st.fetch, st.cfg, st.db);
        st.lastSync = Date.now() / 1000;
        st.blockedUntil.clear();
        await st.names.maybeRefresh(st.fetch, st.cfg.upstream, st.cfg.accounts);
      } catch (e) {
        console.error("sync loop", e);
      }
      if (stopped) break;
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, st.cfg.limits.sync_interval_s * 1000);
        t.unref();
        wake = ok;
      });
      wake = undefined;
    }
  };
  void tick();
  return () => {
    stopped = true;
    wake?.();
  };
};
