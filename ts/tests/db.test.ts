import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { close } from "./helpers.ts";

describe("db", () => {
  it("snapshots roundtrip and pick the latest", () => {
    const db = openDb(":memory:");
    db.addSnapshot({
      ts: 100,
      account: "a",
      pool: "vibe",
      used_eur: 1,
      initial_eur: 10,
      reset_at: 500,
      currency: "EUR",
    });
    db.addSnapshot({
      ts: 200,
      account: "a",
      pool: "vibe",
      used_eur: 2,
      initial_eur: 10,
      reset_at: 500,
      currency: null,
    });
    const s = db.latestSnapshot("a", "vibe");
    expect(s?.used_eur).toBe(2);
    expect(s?.currency).toBeNull();
    expect(db.latestSnapshot("a", "api")).toBeNull();
  });
  it("ledger, costBetween and rowsSince honour bounds and filters", () => {
    const db = openDb(":memory:");
    db.addLedger({ ts: 10, account: "a", pool: "vibe", cost_eur: 1, source: "proxy" });
    db.addLedger({ ts: 20, account: "a", pool: "vibe", cost_eur: 2, source: "sync" });
    db.addLedger({ ts: 30, account: "b", pool: "vibe", cost_eur: 4, source: "proxy" });
    close(db.costBetween("a", "vibe", 0), 3);
    close(db.costBetween("a", "vibe", 10), 2);
    close(db.costBetween("a", "vibe", 10, { inclusive: true }), 3);
    close(db.costBetween("a", "vibe", 0, { upto: 15 }), 1);
    close(db.costBetween("a", "vibe", 0, { source: "proxy" }), 1);
    close(db.costBetween(["a", "b"], "vibe", 0), 7);
    expect(db.rowsSince("a", "vibe", 15)).toEqual([[20, 2]]);
  });
  it("usageRows, recent and byClientSince expose typed rows", () => {
    const db = openDb(":memory:");
    db.addLedger({
      ts: 10,
      account: "a",
      pool: "vibe",
      client: "c1",
      model: "m",
      endpoint: "e",
      cost_eur: 1,
      source: "proxy",
      prompt_tokens: 5,
    });
    db.addLedger({
      ts: 20,
      account: "b",
      pool: "api",
      client: null,
      model: null,
      endpoint: "e",
      cost_eur: 2,
      source: "sync",
    });
    const rows = db.usageRows(0, 30);
    expect(rows.length).toBe(2);
    expect(rows[0]?.model).toBe("m");
    expect(rows[1]?.model).toBeNull();
    const rec = db.recent(10);
    expect(rec[0]?.ts).toBe(20);
    expect(rec[1]?.prompt_tokens).toBe(5);
    const bc = db.byClientSince(0);
    expect(bc).toEqual([{ client: "c1", account: "a", pool: "vibe", n: 1, cost_eur: 1 }]);
  });
  it("links drive canonical and members", () => {
    const db = openDb(":memory:");
    expect(db.canonical("b")).toBe("b");
    db.links.set("c", "a");
    db.links.set("b", "a");
    expect(db.canonical("b")).toBe("a");
    expect(db.members("b")).toEqual(["a", "b", "c"]);
    expect(db.members("a")).toEqual(["a", "b", "c"]);
  });
  it("meta stores and overwrites", () => {
    const db = openDb(":memory:");
    expect(db.getMeta("k")).toBeNull();
    db.setMeta("k", "1");
    db.setMeta("k", "2");
    expect(db.getMeta("k")).toBe("2");
  });
});
