import type { BudgetEngine } from "./budget.ts";
import { createBudgetEngine, poolBlockedBy, poolRetryAt, poolRoom } from "./budget.ts";
import type { DB } from "./db.ts";
import { openDb } from "./db.ts";
import { loadLinks } from "./groups.ts";
import type { ModelNames } from "./modelnames.ts";
import { createModelNames } from "./modelnames.ts";
import type { PriceBook } from "./pricing.ts";
import { createPriceBook } from "./pricing.ts";
import type { SignInApi } from "./signin.ts";
import { createSignIn } from "./signin.ts";
import type { Store } from "./store.ts";
import { createStore } from "./store.ts";
import type { Account, Config, FetchLike, PoolStatus } from "./types.ts";

export type Candidate = { account: Account; pool: string; status: PoolStatus };
export type ExhaustedInfo = {
  pools: { account: string; pool: string; blocked_by: string; retry_at: number | null }[];
  retry_after: number;
};
export type State = {
  readonly cfg: Config;
  readonly db: DB;
  readonly engine: BudgetEngine;
  readonly prices: PriceBook;
  readonly store: Store;
  readonly names: ModelNames;
  readonly signin: SignInApi;
  readonly vibeRe: RegExp;
  readonly blockedUntil: Map<string, number>;
  readonly fetch: FetchLike;
  lastSync: number;
};

export const createState = (cfg: Config, fetchFn: FetchLike = fetch): State => {
  const db = openDb(cfg.db_path);
  const store = createStore(db);
  const blockedUntil = new Map<string, number>();
  const st: State = {
    cfg,
    db,
    engine: createBudgetEngine(db, cfg.limits),
    prices: createPriceBook(cfg.usd_to_eur, cfg.price_overrides),
    store,
    names: createModelNames(db),
    signin: createSignIn({
      cfg,
      db,
      store,
      fetch: fetchFn,
      blockedUntil,
      onSynced: () => {
        st.lastSync = Date.now() / 1000;
      },
    }),
    vibeRe: new RegExp(cfg.limits.vibe_user_agent_regex, "i"),
    blockedUntil,
    fetch: fetchFn,
    lastSync: 0,
  };
  loadLinks(db);
  store.migrateConfig(cfg);
  reloadAccounts(st);
  return st;
};

export const reloadAccounts = (st: State): void => {
  st.cfg.accounts.splice(0, st.cfg.accounts.length, ...st.store.listAccounts());
};

export const classify = (st: State, userAgent: string): "vibe" | "api" => (st.vibeRe.test(userAgent) ? "vibe" : "api");

export const blockKey = (account: string, pool: string): string => `${account}\u0000${pool}`;

export const candidates = (st: State, cls: "vibe" | "api", now: number): Candidate[] => {
  const order = st.cfg.limits.fallback_to_other_pool ? [cls, cls === "vibe" ? "api" : "vibe"] : [cls];
  const out: { rank: number; account: Account; pool: string; status: PoolStatus }[] = [];
  for (const account of st.cfg.accounts) {
    if (!account.enabled) continue;
    order.forEach((pool, rank) => {
      if (!(pool in account.keys)) return;
      if ((st.blockedUntil.get(blockKey(account.name, pool)) ?? 0) > now) return;
      const status = st.engine.status(account.name, pool, now);
      if (status && poolRoom(status) > 0) out.push({ rank, account, pool, status });
    });
  }
  const room = (c: { status: PoolStatus }): number => poolRoom(c.status);
  out.sort(
    st.cfg.limits.strategy === "priority"
      ? (a, b) => a.rank - b.rank || a.account.priority - b.account.priority || room(b) - room(a)
      : (a, b) => a.rank - b.rank || room(b) - room(a) || a.account.priority - b.account.priority,
  );
  return out.map(({ account, pool, status }) => ({ account, pool, status }));
};

export const exhaustedInfo = (st: State, now: number, cls?: "vibe" | "api"): ExhaustedInfo => {
  const order = cls === undefined || st.cfg.limits.fallback_to_other_pool ? ["vibe", "api"] : [cls];
  const pools: ExhaustedInfo["pools"] = [];
  const retry: number[] = [];
  for (const account of st.cfg.accounts) {
    if (!account.enabled) continue;
    for (const pool of order) {
      if (!(pool in account.keys)) continue;
      const status = st.engine.status(account.name, pool, now);
      if (!status) continue;
      const until = st.blockedUntil.get(blockKey(account.name, pool)) ?? 0;
      const blocked = until > now;
      const retryAt = blocked ? until : poolRetryAt(status);
      pools.push({
        account: account.name,
        pool,
        blocked_by: blocked
          ? "temporarily-blocked"
          : (poolBlockedBy(status) ?? (poolRoom(status) > 0 ? "insufficient-room" : "temporarily-blocked")),
        retry_at: retryAt,
      });
      if (retryAt) retry.push(retryAt);
    }
  }
  return { pools, retry_after: retry.length ? Math.max(Math.trunc(Math.min(...retry) - now), 1) : 60 };
};
