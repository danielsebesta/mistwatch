import { describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.ts";
import { bucketStarts, usage } from "../src/usage.ts";
import { close, must } from "./helpers.ts";

const NOW = new Date(2026, 10, 17, 15, 30, 0).getTime() / 1000;
type Tokens = { in: number; out: number; cached?: number };
const add = (
  db: DB,
  agoH: number,
  cost: number,
  model: string | null = "m1",
  client = "c1",
  account = "a",
  pool = "vibe",
  source = "proxy",
  tokens: Tokens | null = null,
): void =>
  db.addLedger({
    ts: NOW - agoH * 3600,
    account,
    pool,
    client,
    model,
    endpoint: "e",
    cost_eur: cost,
    source,
    prompt_tokens: tokens?.in ?? null,
    completion_tokens: tokens?.out ?? null,
    cached_tokens: tokens?.cached ?? null,
  });
describe("usage buckets", () => {
  it("aligns to local hour/day starts", () => {
    const h = bucketStarts(NOW, 24, "hour");
    expect(h.length).toBe(24);
    expect(must(h[23])).toBeLessThanOrEqual(NOW);
    expect(NOW).toBeLessThan(must(h[23]) + 3600);
    close(must(h[1]) - must(h[0]), 3600);
    const ds = bucketStarts(NOW, 7, "day");
    expect(ds.length).toBe(7);
    expect(must(ds[6])).toBeLessThanOrEqual(NOW);
    expect(NOW).toBeLessThan(must(ds[6]) + 90000);
    expect(new Date(must(ds[6]) * 1000).getHours()).toBe(0);
  });
  it("daily series splits by model and compares the previous period", () => {
    const db = openDb(":memory:");
    add(db, 1, 1.0, "m1");
    add(db, 2, 0.5, "m2");
    add(db, 30, 2.0, "m1");
    add(db, 24 * 9, 4.0, "m1");
    const u = usage(db, "7d", "model", NOW);
    const names = new Map(u.series.map((s) => [s.name, s]));
    close(must(names.get("M1")).total, 3.0);
    close(must(names.get("M2")).total, 0.5);
    close(u.total, 3.5);
    close(u.prev_total, 4.0);
    close(
      u.series.reduce((a, s) => a + s.values.reduce((x, y) => x + y, 0), 0),
      3.5,
    );
    expect(u.series[0]?.name).toBe("M1");
    expect(u.buckets.length).toBe(7);
    expect(u.requests).toBe(3);
  });
  it("hourly range folds the tail into other", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 9; i++) add(db, 0.2, 1.0 + i, `model-${i}`, "c1", "a", "vibe", "proxy", { in: 100, out: 10 });
    const u = usage(db, "24h", "model", NOW);
    expect(u.series.length).toBe(7);
    expect(u.series[6]?.name).toBe("other");
    expect(u.series[0]?.name).toBe("Model 8");
    expect(u.unit).toBe("hour");
    expect(u.buckets.length).toBe(24);
    close(
      u.series.reduce((a, s) => a + s.total, 0),
      u.total,
    );
    // the folded tail keeps its tokens
    expect(u.series[6]?.tokens_in).toBe(300);
    expect(u.series[6]?.tokens_out).toBe(30);
    expect(u.tokens_in).toBe(900);
  });
  it("sums tokens per group, per bucket and in total", () => {
    const db = openDb(":memory:");
    add(db, 1, 1.0, "m1", "c1", "a", "vibe", "proxy", { in: 100, out: 20, cached: 40 });
    add(db, 2, 0.5, "m1", "c1", "a", "vibe", "proxy", { in: 300, out: 30 });
    add(db, 3, 0.2, "m2", "c1", "a", "vibe", "proxy", { in: 10, out: 5 });
    add(db, 4, 0.3, null, "(external)", "a", "api", "sync");
    const u = usage(db, "7d", "model", NOW);
    const m1 = must(u.series.find((s) => s.name === "M1"));
    expect(m1.tokens_in).toBe(400);
    expect(m1.tokens_out).toBe(50);
    expect(m1.tokens_cached).toBe(40);
    expect(m1.requests).toBe(2);
    expect(m1.tokens.reduce((a, b) => a + b, 0)).toBe(450);
    expect(u.tokens_in).toBe(410);
    expect(u.tokens_out).toBe(55);
    expect(u.tokens_cached).toBe(40);
    expect(u.requests).toBe(3);
    // a sync row carries no tokens and is not a request
    const ext = must(u.series.find((s) => s.name === "Unknown"));
    expect(ext.tokens_in).toBe(0);
    expect(ext.requests).toBe(0);
  });
  it("groups by client, account, pool and marks unattributed rows as Unknown", () => {
    const db = openDb(":memory:");
    add(db, 1, 1.0, "m1", "vibe-cli", "x", "vibe");
    add(db, 1, 0.3, null, "(external)", "x", "api", "sync");
    add(db, 1, 0.0001, "ministral-3b-latest", "(router)", "y", "vibe");
    expect(new Set(usage(db, "7d", "model", NOW).series.map((s) => s.name))).toEqual(
      new Set(["M1", "Unknown", "Ministral 3 3B"]),
    );
    expect(new Set(usage(db, "7d", "pool", NOW).series.map((s) => s.name))).toEqual(new Set(["vibe", "api"]));
    expect(new Set(usage(db, "7d", "client", NOW).series.map((s) => s.name))).toEqual(
      new Set(["vibe-cli", "Unknown", "(router)"]),
    );
    expect(usage(db, "7d", "account", NOW).requests).toBe(1);
    expect(() => usage(db, "1y", "model", NOW)).toThrow("unknown range");
  });
});
describe("range validation", () => {
  it.each(["constructor", "__proto__", "toString"])("rejects range %s", (r) => {
    expect(() => usage(openDb(":memory:"), r, "model", NOW)).toThrow("unknown range");
  });
});
