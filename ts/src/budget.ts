import type { DB } from "./db.ts";
import type { Limits, PoolStatus, PoolStatusDict, WindowStatus } from "./types.ts";
export const DAY = 86400;
export const WINDOWS: Record<string, number> = { "5h": 5 / 24, day: 1.0, week: 7.0 };
export const MIN_DAYS_LEFT = 1 / 24;
export const poolRoom = (st: PoolStatus): number =>
  Math.min(st.month_room, ...Object.values(st.windows).map((w) => w.room)) - st.inflight;
export const poolPressure = (st: PoolStatus): number => {
  const fr = Object.values(st.windows)
    .filter((w) => w.cap > 0)
    .map((w) => Math.max(w.room, 0) / w.cap);
  const monthCap = st.initial - st.reserve;
  if (monthCap > 0) fr.push(Math.max(st.month_room, 0) / monthCap);
  return fr.length ? Math.min(...fr) : 1.0;
};
export const poolBlockedBy = (st: PoolStatus): string | null => {
  if (poolRoom(st) > 0) return null;
  if (st.month_room - st.inflight <= 0) return "month";
  let worst: WindowStatus | null = null;
  for (const w of Object.values(st.windows)) if (!worst || w.room < worst.room) worst = w;
  return worst ? worst.name : "month";
};
export const poolRetryAt = (st: PoolStatus): number | null => {
  const b = poolBlockedBy(st);
  if (b === null) return null;
  if (b === "month") return st.month_retry_at;
  return st.windows[b]?.retry_at ?? null;
};
const pyRound = (x: number, digits: number): number => {
  const m = x * 10 ** digits;
  const f = Math.floor(m);
  const d = m - f;
  return (d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1) / 10 ** digits;
};
export const poolStatusDict = (st: PoolStatus): PoolStatusDict => ({
  account: st.account,
  pool: st.pool,
  group: st.group,
  members: st.members,
  initial_eur: pyRound(st.initial, 4),
  used_eur: pyRound(st.used, 4),
  remaining_eur: pyRound(st.remaining, 4),
  reserve_eur: pyRound(st.reserve, 4),
  reset_at: st.reset_at,
  days_left: pyRound(st.days_left, 3),
  snapshot_age_s: pyRound(st.snapshot_age_s, 1),
  daily_fair_share_eur: pyRound(Math.max(st.remaining - st.reserve, 0) / st.days_left, 4),
  room_eur: pyRound(poolRoom(st), 4),
  blocked_by: poolBlockedBy(st),
  retry_at: poolRetryAt(st),
  month: { cap: pyRound(st.initial - st.reserve, 4), spent: pyRound(st.used, 4), room: pyRound(st.month_room, 4) },
  windows: Object.fromEntries(
    Object.entries(st.windows).map(([n, w]) => [
      n,
      { cap: pyRound(w.cap, 4), spent: pyRound(w.spent, 4), room: pyRound(w.room, 4), retry_at: w.retry_at },
    ]),
  ),
});
export type BudgetEngine = {
  readonly db: DB;
  inflight: Map<string, number>;
  burst(name: string): number;
  status(account: string, pool: string, now?: number): PoolStatus | null;
  reserve(account: string, pool: string, est: number): void;
  release(account: string, pool: string, est: number): void;
};
export const createBudgetEngine = (db: DB, limits: Limits): BudgetEngine => {
  const inflight = new Map<string, number>();
  const ikey = (account: string, pool: string): string => `${db.canonical(account)}${pool}`;
  const burst = (name: string): number => {
    const v =
      name === "5h"
        ? limits.burst_5h
        : name === "day"
          ? limits.burst_day
          : name === "week"
            ? limits.burst_week
            : undefined;
    if (v === undefined) throw new RangeError(`unknown window ${name}`);
    return v;
  };
  const windowRetry = (rows: [number, number][], length: number, remaining: number, k: number): number | null => {
    if (k >= 1) return null;
    const target = (remaining * k) / (1 - k);
    let s = 0;
    for (const [, c] of rows) s += c;
    for (const [ts, cost] of rows) {
      s -= cost;
      if (s < target) return ts + length * DAY + 1;
    }
    const last = rows[rows.length - 1];
    return last ? last[0] + length * DAY + 1 : null;
  };
  const status = (account: string, pool: string, now?: number): PoolStatus | null => {
    const t = now || Date.now() / 1000;
    let canon = db.canonical(account);
    let snap = db.latestSnapshot(canon, pool);
    if (snap === null && canon !== account) {
      canon = account;
      snap = db.latestSnapshot(account, pool);
    }
    if (snap === null) return null;
    const members = db.members(canon);
    const initial = snap.initial_eur;
    const rolled = t >= snap.reset_at;
    let used: number;
    let daysLeft: number;
    if (rolled) {
      used = db.costBetween(members, pool, snap.reset_at, { inclusive: true });
      daysLeft = 30.0;
    } else {
      used = snap.used_eur + db.costBetween(members, pool, snap.ts);
      daysLeft = Math.max((snap.reset_at - t) / DAY, MIN_DAYS_LEFT);
    }
    const remaining = initial - used;
    const reserve = (initial * limits.reserve_pct) / 100;
    const monthRoom = remaining - reserve;
    const st: PoolStatus = {
      account,
      pool,
      initial,
      used,
      remaining,
      reserve,
      reset_at: snap.reset_at,
      days_left: daysLeft,
      snapshot_age_s: t - snap.ts,
      windows: {},
      month_room: monthRoom,
      month_retry_at: monthRoom <= 0 ? snap.reset_at : null,
      inflight: inflight.get(`${canon}${pool}`) ?? 0,
      group: canon,
      members,
    };
    for (const [name, length] of Object.entries(WINDOWS)) {
      const rows = db.rowsSince(members, pool, t - length * DAY);
      let spent = 0;
      for (const [, c] of rows) spent += c;
      const b0 = Math.min(Math.max(remaining, 0) + spent, initial);
      const k = (length / (daysLeft + length)) * burst(name);
      const cap = b0 * k;
      const room = cap - spent;
      st.windows[name] = {
        name,
        length_days: length,
        cap,
        spent,
        room,
        retry_at: room <= 0 && rows.length ? windowRetry(rows, length, Math.max(remaining, 0), k) : null,
      };
    }
    return st;
  };
  const engine: BudgetEngine = {
    db,
    inflight,
    burst,
    status,
    reserve: (account, pool, est) => {
      const k = ikey(account, pool);
      inflight.set(k, (inflight.get(k) ?? 0) + est);
    },
    release: (account, pool, est) => {
      const k = ikey(account, pool);
      inflight.set(k, Math.max((inflight.get(k) ?? 0) - est, 0));
    },
  };
  return engine;
};
