import { describe, expect, it } from "vitest";
import { type BudgetEngine, createBudgetEngine, poolRoom } from "../src/budget.ts";
import { defaultLimits } from "../src/config.ts";
import { type DB, openDb } from "../src/db.ts";
import { loadLinks, refreshLinks, summarize } from "../src/groups.ts";
import type { PoolStatus } from "../src/types.ts";
import { accounts, close, must, NOW, seed } from "./helpers.ts";

const eng = (db: DB) => createBudgetEngine(db, defaultLimits());
const linksObj = (db: DB) => Object.fromEntries(db.links);
const stat = (e: ReturnType<typeof eng>, a: string, now: number): PoolStatus => must(e.status(a, "vibe", now));
const w = (s: PoolStatus, name: string) => must(s.windows[name]);
describe("shared-budget detection", () => {
  it("three keys on one account count as one budget", () => {
    const db = openDb(":memory:");
    for (const n of ["a", "b", "c"]) seed(db, n, 20.123456789, 0.004123);
    const accs = accounts("a", "b", "c");
    expect(Object.fromEntries(refreshLinks(db, accs))).toEqual({ b: "a", c: "a" });
    expect(new Set(db.linksInfo.values())).toEqual(new Set(["sure"]));
    const s = summarize(eng(db), accs, NOW);
    const vibe = must(s.pools.vibe);
    expect(vibe.budgets).toBe(1);
    close(vibe.initial_eur, 127.5);
    expect(vibe.accounts).toEqual(["a", "b", "c"]);
    close(must(s.all).initial_eur, 127.5 + 12.75);
    expect(s.shared).toEqual([{ canonical: "a", members: ["a", "b", "c"], confidence: "sure" }]);
  });
  it("spend through any member counts for all", () => {
    const db = openDb(":memory:");
    for (const n of ["a", "b"]) seed(db, n, 10.5);
    const accs = accounts("a", "b");
    const e = eng(db);
    const beforeA = w(stat(e, "a", NOW + 60), "day").room;
    refreshLinks(db, accs);
    db.addLedger({ ts: NOW + 30, account: "b", pool: "vibe", cost_eur: 3.0, source: "proxy" });
    const [sa, sb] = [stat(e, "a", NOW + 60), stat(e, "b", NOW + 60)];
    close(sa.used, 13.5);
    close(sb.used, 13.5);
    close(w(sa, "day").spent, 3.0);
    expect(w(sa, "day").room).toBeLessThan(beforeA);
    close(poolRoom(sa), poolRoom(sb));
  });
  it("reservations are shared too", () => {
    const db = openDb(":memory:");
    for (const n of ["a", "b"]) seed(db, n, 1.0);
    refreshLinks(db, accounts("a", "b"));
    const e = eng(db);
    e.tryReserve("b", "vibe", 0.5, 10);
    close(stat(e, "a", NOW + 1).inflight, 0.5);
  });
  it("zero usage merges conservatively then splits on divergence", () => {
    const db = openDb(":memory:");
    for (const n of ["a", "b"]) seed(db, n);
    const accs = accounts("a", "b");
    refreshLinks(db, accs);
    expect(linksObj(db)).toEqual({ b: "a" });
    expect(Object.fromEntries(db.linksInfo)).toEqual({ b: "likely" });
    const later = NOW + 300;
    seed(db, "a", 2.0, 0, 127.5, 12.75, later);
    seed(db, "b", 0.0, 0, 127.5, 12.75, later + 2);
    refreshLinks(db, accs);
    expect(db.links.size).toBe(0);
  });
  it("different budgets are summed", () => {
    const db = openDb(":memory:");
    seed(db, "me", 127.5, 0.01);
    seed(db, "school", 0, 0, 255.0, 25.5);
    const accs = accounts("me", "school");
    expect(Object.fromEntries(refreshLinks(db, accs))).toEqual({});
    const s = summarize(eng(db), accs, NOW);
    const vibe = must(s.pools.vibe);
    expect(vibe.budgets).toBe(2);
    close(vibe.initial_eur, 382.5);
    close(vibe.remaining_eur, 255.0);
    expect(vibe.room_eur).toBeGreaterThan(0);
    expect(vibe.blocked).toBe(false);
    close(must(s.all).initial_eur, 382.5 + 38.25);
    expect(s.shared).toEqual([]);
  });
  it("a stale account keeps its link", () => {
    const db = openDb(":memory:");
    for (const n of ["a", "b"]) seed(db, n, 5.5);
    const accs = accounts("a", "b", "c");
    refreshLinks(db, accs.slice(0, 2));
    expect(linksObj(db)).toEqual({ b: "a" });
    const later = NOW + 1000;
    seed(db, "a", 6.5, 0, 127.5, 12.75, later);
    seed(db, "c", 1.0, 0, 127.5, 12.75, later);
    refreshLinks(db, accs);
    expect(linksObj(db)).toEqual({ b: "a" });
  });
  it("passes an explicit now of 0 through to status", () => {
    const db = openDb(":memory:");
    seed(db, "a");
    const real = eng(db);
    const seen: (number | undefined)[] = [];
    const spy: BudgetEngine = {
      ...real,
      status: (a, p, n) => {
        seen.push(n);
        return real.status(a, p, n);
      },
    };
    summarize(spy, accounts("a"), 0);
    expect(seen).toEqual([0, 0]);
  });
  it("disabled accounts are ignored", () => {
    const db = openDb(":memory:");
    seed(db, "a", 1.0);
    seed(db, "b", 1.0);
    const accs = accounts("a", "b");
    must(accs[1]).enabled = false;
    const s = summarize(eng(db), accs, NOW);
    expect(must(s.pools.vibe).accounts).toEqual(["a"]);
  });
  it("links persist through meta and corrupt data clears them", () => {
    const db = openDb(":memory:");
    for (const n of ["a", "b"]) seed(db, n, 5.5);
    refreshLinks(db, accounts("a", "b"));
    db.links = new Map();
    db.linksInfo = new Map();
    loadLinks(db);
    expect(linksObj(db)).toEqual({ b: "a" });
    expect(Object.fromEntries(db.linksInfo)).toEqual({ b: "sure" });
    db.setMeta("links", "not json{");
    loadLinks(db);
    expect(db.links.size).toBe(0);
  });
});
describe("prototype-named accounts", () => {
  it("dedupes `__proto__` and `normal` with identical snapshots", () => {
    const db = openDb(":memory:");
    for (const n of ["__proto__", "normal"]) seed(db, n, 20.5, 0.004);
    refreshLinks(db, accounts("__proto__", "normal"));
    expect([...db.links]).toEqual([["normal", "__proto__"]]);
  });
});
