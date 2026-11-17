import { describe, expect, it } from "vitest";
import { type BudgetEngine, createBudgetEngine, DAY, poolBlockedBy, poolRetryAt, poolRoom } from "../src/budget.ts";
import { defaultLimits } from "../src/config.ts";
import { type DB, openDb } from "../src/db.ts";
import { createPriceBook } from "../src/pricing.ts";
import type { Limits, PoolStatus } from "../src/types.ts";
import { close, must } from "./helpers.ts";

const mk = (initial = 127.5, used = 0, daysLeft = 30, lim: Partial<Limits> = {}): [DB, BudgetEngine, number] => {
  const db = openDb(":memory:");
  const now = Date.now() / 1000;
  db.addSnapshot({
    ts: now,
    account: "a",
    pool: "vibe",
    used_eur: used,
    initial_eur: initial,
    reset_at: now + daysLeft * DAY,
    currency: "EUR",
  });
  return [db, createBudgetEngine(db, { ...defaultLimits(), ...lim }), now];
};
const win = (s: PoolStatus, name: string) => must(s.windows[name]);
describe("budget pacing", () => {
  it("fair share at an even pace", () => {
    const [, eng, now] = mk();
    const s = must(eng.status("a", "vibe", now));
    expect(Math.abs(win(s, "day").cap - (127.5 / 31) * 1.5)).toBeLessThan(0.05);
    expect(poolRoom(s)).toBeGreaterThan(0);
    expect(poolBlockedBy(s)).toBeNull();
  });
  it("unspent budget raises limits over time", () => {
    const [, e1, n1] = mk(127.5, 0, 30);
    const [, e2, n2] = mk(127.5, 0, 15);
    expect(win(must(e2.status("a", "vibe", n2)), "day").cap).toBeGreaterThan(
      1.8 * win(must(e1.status("a", "vibe", n1)), "day").cap,
    );
  });
  it("window blocks then frees as spend rolls off", () => {
    const [db, eng, now] = mk();
    const cap = win(must(eng.status("a", "vibe", now)), "5h").cap;
    db.addLedger({ ts: now - 60, account: "a", pool: "vibe", cost_eur: cap + 1, source: "proxy" });
    const s = must(eng.status("a", "vibe", now));
    expect(poolBlockedBy(s)).toBe("5h");
    const retry = must(poolRetryAt(s));
    expect(retry).toBeGreaterThan(now);
    expect(retry).toBeLessThanOrEqual(now + (5 / 24) * DAY + 5);
    const later = must(eng.status("a", "vibe", now + (5 / 24) * DAY + 10));
    expect(win(later, "5h").room).toBeGreaterThan(0);
  });
  it("monthly hard cap on an exhausted pool", () => {
    const [, eng, now] = mk(127.5, 127.5);
    const s = must(eng.status("a", "vibe", now));
    expect(poolBlockedBy(s)).toBe("month");
    expect(poolRetryAt(s)).toBe(s.reset_at);
  });
  it("reserve blocks before zero", () => {
    const [, eng, now] = mk(127.5, 127.5 * 0.98, 30, { reserve_pct: 3.0 });
    expect(must(eng.status("a", "vibe", now)).month_room).toBeLessThan(0);
  });
  it("inflight reservations reduce room", () => {
    const [, eng, now] = mk();
    const before = poolRoom(must(eng.status("a", "vibe", now)));
    eng.tryReserve("a", "vibe", 1.0, 10);
    close(before - poolRoom(must(eng.status("a", "vibe", now))), 1.0);
  });
  it("honours an explicit now of 0", () => {
    const [, eng, now] = mk();
    const s = must(eng.status("a", "vibe", 0));
    close(s.snapshot_age_s, -now);
    expect(must(s.windows.week).spent).toBe(0);
  });
});
describe("pricing", () => {
  it("costs, aliases and fallback", () => {
    const pb = createPriceBook(1.0);
    const [c1, exact1] = pb.costEur("mistral-large-4-0", 1_000_000, 1_000_000);
    expect(exact1).toBe(true);
    close(c1, 2.8);
    const [, exact2] = pb.costEur("mistral-vibe-cli-latest", 1000, 1000);
    expect(exact2).toBe(true);
    const [, exact3] = pb.costEur("something-new", 10, 10);
    expect(exact3).toBe(false);
  });
});
