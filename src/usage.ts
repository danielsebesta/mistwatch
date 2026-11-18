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
  const totals = new Map<string, number>();
  const per = new Map<string, number[]>();
  for (const r of rows) {
    const i = bisectRight(starts, r.ts) - 1;
    if (i < 0) continue;
    const name = label(r, by, nm);
    let vals = per.get(name);
    if (!vals) {
      vals = new Array<number>(n).fill(0);
      per.set(name, vals);
    }
    vals[i] = (vals[i] ?? 0) + r.cost_eur;
    totals.set(name, (totals.get(name) ?? 0) + r.cost_eur);
  }
  const ranked = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const keep = ranked.slice(0, TOP_N);
  const rest = ranked.slice(TOP_N);
  const series: UsageSeries[] = keep.map((k) => ({
    name: k,
    total: totals.get(k) ?? 0,
    values: per.get(k) ?? new Array<number>(n).fill(0),
  }));
  if (rest.length) {
    const vals = Array.from({ length: n }, (_, i) => rest.reduce((a, k) => a + (per.get(k)?.[i] ?? 0), 0));
    series.push({ name: OTHER, total: rest.reduce((a, k) => a + (totals.get(k) ?? 0), 0), values: vals });
  }
  return {
    range,
    by,
    unit,
    buckets: starts,
    step: unit === "hour" ? 3600 : 86400,
    series,
    total: rows.reduce((a, r) => a + r.cost_eur, 0),
    prev_total: prevTotal,
    requests: rows.filter((r) => r.source === "proxy" && r.client !== "(router)").length,
  };
};
