import { type BudgetEngine, poolRetryAt, poolRoom, WINDOWS } from "./budget.ts";
import type { DB } from "./db.ts";
import type { Account, PoolAgg, PoolStatus, SharedGroup, Snapshot, Summary, WindowAgg } from "./types.ts";
import { POOLS } from "./types.ts";
export const SAME_PASS_S = 90.0;
export const EPS_EUR = 1e-6;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const loadLinks = (db: DB): void => {
  const raw = db.getMeta("links");
  db.links = new Map();
  db.linksInfo = new Map();
  if (!raw) return;
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRec(data)) throw new TypeError("bad links");
    const links = new Map<string, string>();
    const info = new Map<string, string>();
    for (const [k, v] of Object.entries(data)) {
      if (!isRec(v) || typeof v.canonical !== "string" || typeof v.confidence !== "string")
        throw new TypeError("bad links");
      links.set(k, v.canonical);
      info.set(k, v.confidence);
    }
    db.links = links;
    db.linksInfo = info;
  } catch {
    db.links = new Map();
    db.linksInfo = new Map();
  }
};
const sameSnaps = (a: Record<string, Snapshot>, b: Record<string, Snapshot>): boolean => {
  const ka = Object.keys(a);
  if (!ka.length || ka.length !== Object.keys(b).length) return false;
  for (const pool of ka) {
    const x = a[pool];
    const y = b[pool];
    if (!x || !y) return false;
    if (
      Math.abs(x.initial_eur - y.initial_eur) > EPS_EUR ||
      Math.abs(x.reset_at - y.reset_at) > 1 ||
      Math.abs(x.used_eur - y.used_eur) > EPS_EUR
    )
      return false;
  }
  return true;
};
export const refreshLinks = (db: DB, accounts: Account[]): Map<string, string> => {
  const snaps: Record<string, Record<string, Snapshot>> = {};
  for (const a of accounts) {
    const per: Record<string, Snapshot> = {};
    for (const p of POOLS) {
      const s = db.latestSnapshot(a.name, p);
      if (s) per[p] = s;
    }
    if (Object.keys(per).length) snaps[a.name] = per;
  }
  if (!Object.keys(snaps).length) return db.links;
  let newest = -Infinity;
  for (const per of Object.values(snaps)) for (const s of Object.values(per)) newest = Math.max(newest, s.ts);
  const fresh: Record<string, Record<string, Snapshot>> = {};
  const stale = new Set<string>();
  for (const [n, per] of Object.entries(snaps)) {
    let minTs = Infinity;
    for (const s of Object.values(per)) minTs = Math.min(minTs, s.ts);
    if (minTs >= newest - SAME_PASS_S) fresh[n] = per;
    else stale.add(n);
  }
  const names = Object.keys(fresh).sort();
  const parent = new Map<string, string>(names.map((n) => [n, n]));
  const find = (x: string): string => {
    let cur = x;
    for (;;) {
      const p = parent.get(cur) ?? cur;
      if (p === cur) return cur;
      parent.set(cur, parent.get(p) ?? p);
      cur = p;
    }
  };
  for (let i = 0; i < names.length; i++) {
    const x = names[i];
    if (x === undefined) continue;
    const fx = fresh[x];
    for (const y of names.slice(i + 1)) {
      const fy = fresh[y];
      if (fx && fy && sameSnaps(fx, fy)) parent.set(find(y), find(x));
    }
  }
  const clusters = new Map<string, string[]>();
  for (const n of names) {
    const r = find(n);
    const arr = clusters.get(r);
    if (arr) arr.push(n);
    else clusters.set(r, [n]);
  }
  const prio = new Map(accounts.map((a) => [a.name, a.priority]));
  const links = new Map<string, string>();
  const info = new Map<string, string>();
  for (const [m, c] of db.links) {
    if (stale.has(m) || stale.has(c)) {
      links.set(m, c);
      info.set(m, db.linksInfo.get(m) ?? "likely");
    }
  }
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    let canon = members[0] ?? "";
    for (const m of members) {
      const pm = prio.get(m) ?? 999;
      const pc = prio.get(canon) ?? 999;
      if (pm < pc || (pm === pc && m < canon)) canon = m;
    }
    const per = fresh[canon];
    const spent = per ? Object.values(per).some((s) => s.used_eur > EPS_EUR) : false;
    for (const m of members) {
      if (m !== canon) {
        links.set(m, canon);
        info.set(m, spent ? "sure" : "likely");
      }
    }
  }
  db.links = links;
  db.linksInfo = info;
  db.setMeta(
    "links",
    JSON.stringify(
      Object.fromEntries([...links].map(([m, c]) => [m, { canonical: c, confidence: info.get(m) ?? "likely" }])),
    ),
  );
  return links;
};
export const sharedGroups = (db: DB): SharedGroup[] => {
  const out = new Map<string, SharedGroup>();
  for (const [m, c] of db.links) {
    let g = out.get(c);
    if (!g) {
      g = { canonical: c, members: [c], confidence: "sure" };
      out.set(c, g);
    }
    g.members.push(m);
    if (db.linksInfo.get(m) !== "sure") g.confidence = "likely";
  }
  return [...out.values()].map((g) => ({ ...g, members: [...g.members].sort() }));
};
const pos = (x: number): number => Math.max(x, 0);
const sumOf = (xs: PoolStatus[], f: (s: PoolStatus) => number): number => xs.reduce((a, s) => a + f(s), 0);
const agg = (statuses: PoolStatus[]): PoolAgg => {
  const windows: Record<string, WindowAgg> = {};
  for (const n of Object.keys(WINDOWS)) {
    let cap = 0;
    let spent = 0;
    let room = 0;
    for (const s of statuses) {
      const w = s.windows[n];
      if (w) {
        cap += w.cap;
        spent += w.spent;
        room += pos(w.room);
      }
    }
    windows[n] = { cap, spent, room };
  }
  const blocked = statuses.filter((s) => poolRoom(s) <= 0);
  const allBlocked = statuses.length > 0 && blocked.length === statuses.length;
  const retries = blocked.map((s) => poolRetryAt(s)).filter((x): x is number => x !== null);
  return {
    budgets: statuses.length,
    accounts: [...new Set(statuses.flatMap((s) => s.members))].sort(),
    initial_eur: sumOf(statuses, (s) => s.initial),
    used_eur: sumOf(statuses, (s) => s.used),
    remaining_eur: sumOf(statuses, (s) => pos(s.remaining)),
    month: {
      cap: sumOf(statuses, (s) => s.initial - s.reserve),
      spent: sumOf(statuses, (s) => s.used),
      room: sumOf(statuses, (s) => pos(s.month_room)),
    },
    room_eur: sumOf(statuses, (s) => pos(poolRoom(s))),
    fair_daily_eur: sumOf(statuses, (s) => pos(s.remaining - s.reserve) / s.days_left),
    windows,
    blocked: allBlocked,
    retry_at: allBlocked && retries.length ? Math.min(...retries) : null,
    reset_at: statuses.length ? Math.min(...statuses.map((s) => s.reset_at)) : null,
  };
};
export const summarize = (engine: BudgetEngine, accounts: Account[], now?: number): Summary => {
  const t = now || Date.now() / 1000;
  const seen = new Set<string>();
  const byPool: Record<string, PoolStatus[]> = { vibe: [], api: [] };
  for (const a of accounts) {
    if (!a.enabled) continue;
    for (const pool of POOLS) {
      const s = engine.status(a.name, pool, t);
      if (!s) continue;
      const key = `${s.group}${pool}`;
      if (seen.has(key)) continue;
      seen.add(key);
      byPool[pool]?.push(s);
    }
  }
  const pools: Record<string, PoolAgg> = {};
  for (const [p, v] of Object.entries(byPool)) if (v.length) pools[p] = agg(v);
  const all = Object.values(byPool).flat();
  return {
    pools,
    all: seen.size ? agg(all) : null,
    shared: sharedGroups(engine.db),
    accounts: accounts.filter((a) => a.enabled).length,
  };
};
