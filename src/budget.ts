import type { DB } from "./db.ts";
import { createReservationLedger, type Reservation } from "./queue.ts";
import type { Limits, PoolStatus, PoolStatusDict, WindowStatus } from "./types.ts";
export const DAY = 86400;
export const WINDOWS: Record<string, number> = { "5h": 5 / 24, day: 1.0, week: 7.0 };
export const MIN_DAYS_LEFT = 1 / 24;
export const BOOST_HOURS = 5;
const localDay = (t: number): string => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
export type BoostInfo = { active: boolean; until: number | null; available: boolean; hours: number };
// A boost lifts the 5 h and day pacing windows (never week or month) for BOOST_HOURS, once per local day.
export const boostInfo = (db: DB, now: number = Date.now() / 1000): BoostInfo => {
  const until = Number(db.getMeta("boost_until") ?? 0);
  const active = Number.isFinite(until) && now < until;
  const usedToday = db.getMeta("boost_day") === localDay(now);
  return { active, until: active ? until : null, available: !active && !usedToday, hours: BOOST_HOURS };
};
export const startBoost = (db: DB, now: number = Date.now() / 1000): BoostInfo => {
  const b = boostInfo(db, now);
  if (b.active) throw new RangeError("A boost is already running.");
  if (!b.available) throw new RangeError("Today's boost is already used. It is available again after midnight.");
  db.setMeta("boost_until", String(now + BOOST_HOURS * 3600));
  db.setMeta("boost_day", localDay(now));
  return boostInfo(db, now);
};
export const poolRoom = (st: PoolStatus): number =>
  Math.min(st.month_room, ...Object.values(st.windows).map((w) => w.room)) - st.inflight;
export const poolGrossRoom = (st: PoolStatus): number =>
  Math.min(st.month_room, ...Object.values(st.windows).map((w) => w.room));
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
const f64 = new DataView(new ArrayBuffer(8));
// Round half to even on the exact binary value, then the nearest double of the decimal result
export const roundTo = (x: number, digits: number): number => {
  if (!Number.isFinite(x) || x === 0) return x;
  f64.setFloat64(0, Math.abs(x));
  const bits = f64.getBigUint64(0);
  const be = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  const mant = be === 0 ? frac : frac | (1n << 52n);
  const e = (be === 0 ? 1 : be) - 1075;
  const num = mant * 10n ** BigInt(digits);
  let n: bigint;
  if (e >= 0) n = num << BigInt(e);
  else {
    const den = 1n << BigInt(-e);
    n = num / den;
    const twice = (num % den) * 2n;
    if (twice > den || (twice === den && n % 2n === 1n)) n += 1n;
  }
  return Number(`${x < 0 ? "-" : ""}${n}e-${digits}`);
};
export const poolStatusDict = (st: PoolStatus): PoolStatusDict => ({
  account: st.account,
  pool: st.pool,
  group: st.group,
  members: st.members,
  initial_eur: roundTo(st.initial, 4),
  used_eur: roundTo(st.used, 4),
  remaining_eur: roundTo(st.remaining, 4),
  reserve_eur: roundTo(st.reserve, 4),
  reset_at: st.reset_at,
  days_left: roundTo(st.days_left, 3),
  snapshot_age_s: roundTo(st.snapshot_age_s, 1),
  daily_fair_share_eur: roundTo(Math.max(st.remaining - st.reserve, 0) / st.days_left, 4),
  room_eur: roundTo(poolRoom(st), 4),
  blocked_by: poolBlockedBy(st),
  retry_at: poolRetryAt(st),
  month: { cap: roundTo(st.initial - st.reserve, 4), spent: roundTo(st.used, 4), room: roundTo(st.month_room, 4) },
  windows: Object.fromEntries(
    Object.entries(st.windows).map(([n, w]) => [
      n,
      { cap: roundTo(w.cap, 4), spent: roundTo(w.spent, 4), room: roundTo(w.room, 4), retry_at: w.retry_at },
    ]),
  ),
});
export type BudgetEngine = {
  readonly db: DB;
  burst(name: string): number;
  status(account: string, pool: string, now?: number): PoolStatus | null;
  tryReserve(account: string, pool: string, est: number, room: number): Reservation | null;
};
export const createBudgetEngine = (db: DB, limits: Limits): BudgetEngine => {
  const ledger = createReservationLedger();
  const widest = Math.max(...Object.values(WINDOWS));
  const ikey = (canon: string, pool: string): string => `${canon}\u0000${pool}`;
  const heldBy = (accounts: string[], pool: string): number => {
    let s = 0;
    for (const m of accounts) s += ledger.outstanding(ikey(m, pool));
    return s;
  };
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
    const t = now ?? Date.now() / 1000;
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
      inflight: heldBy(members.includes(account) ? members : [...members, account], pool),
      group: canon,
      members,
    };
    const boosted = boostInfo(db, t).active;
    const wideRows = db.rowsSince(members, pool, t - widest * DAY);
    for (const [name, length] of Object.entries(WINDOWS)) {
      const rows = wideRows.filter(([ts]) => ts >= t - length * DAY);
      let spent = 0;
      for (const [, c] of rows) spent += c;
      const b0 = Math.min(Math.max(remaining, 0) + spent, initial);
      const k = (length / (daysLeft + length)) * burst(name);
      // boosted: the 5 h and day windows only stop at the month budget, so the cap follows what is left there
      const lifted = boosted && name !== "week";
      const room = lifted ? Math.max(b0 * k - spent, monthRoom) : b0 * k - spent;
      const cap = lifted ? spent + room : b0 * k;
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
    burst,
    status,
    tryReserve: (account, pool, est, room) => {
      const group = db.members(db.canonical(account)).filter((m) => m !== account);
      return ledger.tryReserve(ikey(account, pool), est, room - heldBy(group, pool));
    },
  };
  return engine;
};
