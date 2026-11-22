import type { DB } from "./db.ts";
import { createModelNames, type ModelNames } from "./modelnames.ts";
import type { UsageResult, UsageRow, UsageSeries } from "./types.ts";
export const RANGES: Record<string, [number, "hour" | "day"]> = {
  "24h": [24, "hour"],
  "7d": [7, "day"],
  "30d": [30, "day"],
};
export const DIMENSIONS: readonly string[] = ["model", "client", "account", "pool"];
export const TOP_N = 6;
export const OTHER = "other";
export const bucketStarts = (now: number, n: number, unit: "hour" | "day"): number[] => {
  const cur = new Date(now * 1000);
  const out: number[] = [];
  if (unit === "hour") {
    const top = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), cur.getHours());
    for (let i = n - 1; i >= 0; i--) out.push((top.getTime() - i * 3600_000) / 1000);
  } else {
    const top = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(top);
      d.setDate(d.getDate() - i);
      out.push(d.getTime() / 1000);
    }
  }
  return out;
};
const label = (row: UsageRow, by: string, names: ModelNames): string => {
  if (by === "model") {
    if (!row.model) return row.source === "sync" ? "(external)" : "(unknown)";
    return names.display(row.model);
  }
  if (by === "client") return row.client || "—";
  const v = by === "account" ? row.account : row.pool;
  return v || "—";
};
const bisectRight = (xs: number[], x: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = xs[mid];
    if (v === undefined) break;
    if (x < v) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};
// one row per group: cost and tokens per bucket, plus the totals the table shows
type Acc = {
  values: number[];
  tokens: number[];
  total: number;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
};
const blank = (n: number): Acc => ({
  values: new Array<number>(n).fill(0),
  tokens: new Array<number>(n).fill(0),
  total: 0,
  requests: 0,
  tokens_in: 0,
  tokens_out: 0,
  tokens_cached: 0,
});
// router calls are bookkeeping, not requests the user made
const isRequest = (r: UsageRow): boolean => r.source === "proxy" && r.client !== "(router)";
const add = (a: Acc, r: UsageRow, i: number): void => {
  const tin = r.prompt_tokens ?? 0;
  const tout = r.completion_tokens ?? 0;
  a.values[i] = (a.values[i] ?? 0) + r.cost_eur;
  a.tokens[i] = (a.tokens[i] ?? 0) + tin + tout;
  a.total += r.cost_eur;
  a.tokens_in += tin;
  a.tokens_out += tout;
  a.tokens_cached += r.cached_tokens ?? 0;
  if (isRequest(r)) a.requests += 1;
};
const merge = (into: Acc, from: Acc): Acc => {
  for (let i = 0; i < into.values.length; i++) {
    into.values[i] = (into.values[i] ?? 0) + (from.values[i] ?? 0);
    into.tokens[i] = (into.tokens[i] ?? 0) + (from.tokens[i] ?? 0);
  }
  into.total += from.total;
  into.requests += from.requests;
  into.tokens_in += from.tokens_in;
  into.tokens_out += from.tokens_out;
  into.tokens_cached += from.tokens_cached;
  return into;
};
const seriesOf = (name: string, a: Acc): UsageSeries => ({
  name,
  total: a.total,
  values: a.values,
  tokens: a.tokens,
  requests: a.requests,
  tokens_in: a.tokens_in,
  tokens_out: a.tokens_out,
  tokens_cached: a.tokens_cached,
});
export const usage = (db: DB, range: string, by: string, now: number, names?: ModelNames): UsageResult => {
  const spec = Object.hasOwn(RANGES, range) ? RANGES[range] : undefined;
  if (!spec) throw new Error("unknown range");
  if (!DIMENSIONS.includes(by)) throw new Error("unknown grouping");
  const nm = names ?? createModelNames(db);
  const [n, unit] = spec;
  const starts = bucketStarts(now, n, unit);
  const since = starts[0] ?? now;
  const span = (starts[starts.length - 1] ?? now) - since + (unit === "hour" ? 3600 : 86400);
  const rows = db.usageRows(since, now + 1);
  const prevTotal = db.sumCost(since - span, since);
  const acc = new Map<string, Acc>();
  const all = blank(n);
  for (const r of rows) {
    const i = bisectRight(starts, r.ts) - 1;
    if (i < 0) continue;
    const name = label(r, by, nm);
    let a = acc.get(name);
    if (!a) {
      a = blank(n);
      acc.set(name, a);
    }
    add(a, r, i);
    add(all, r, i);
  }
  const ranked = [...acc.keys()].sort((a, b) => (acc.get(b)?.total ?? 0) - (acc.get(a)?.total ?? 0));
  const keep = ranked.slice(0, TOP_N);
  const rest = ranked.slice(TOP_N);
  const series: UsageSeries[] = keep.map((k) => seriesOf(k, acc.get(k) ?? blank(n)));
  if (rest.length) {
    const other = rest.reduce((a, k) => merge(a, acc.get(k) ?? blank(n)), blank(n));
    series.push(seriesOf(OTHER, other));
  }
  return {
    range,
    by,
    unit,
    buckets: starts,
    step: unit === "hour" ? 3600 : 86400,
    series,
    total: all.total,
    prev_total: prevTotal,
    requests: all.requests,
    tokens_in: all.tokens_in,
    tokens_out: all.tokens_out,
    tokens_cached: all.tokens_cached,
  };
};
