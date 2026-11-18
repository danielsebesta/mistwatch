import { afterEach, describe, expect, it, vi } from "vitest";
import { createBudgetEngine } from "../src/budget.ts";
import { defaultConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createState } from "../src/state.ts";
import { checkKey, nextReset, parseIso, prevReset, startSyncLoop, syncAll } from "../src/sync.ts";
import type { Account, FetchLike } from "../src/types.ts";
import { must } from "./helpers.ts";

process.env.MISTWATCH_NO_KEYRING = "1";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (h: Handler, calls: { url: string; auth: string | null }[] = []): FetchLike => {
  const f: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return Promise.resolve(h(url, init));
  };
  return f;
};
const BUDGET = {
  vibe_budget: { usage_percentage: 10, initial_budget: 100, reset_at: "2099-01-01T00:00:00Z", currency: "EUR" },
  api_budget: { usage_percentage: 50, initial_budget: 10, reset_at: "2099-01-01T00:00:00Z", currency: "EUR" },
};
const acct = (name: string, keys: Record<string, string>, manual: Account["manual"] = {}): Account => ({
  name,
  keys,
  priority: 100,
  enabled: true,
  manual,
});
const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  for (;;) {
    if (cond()) return;
    if (Date.now() > end) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("sync", () => {
  it("records mistral budget snapshots for each pool", async () => {
    const db = openDb(":memory:");
    const cfg = defaultConfig();
    cfg.accounts.push(acct("a", { vibe: "vibe-key" }));
    const res = await syncAll(
      fakeFetch((url) => (url.endsWith("/v1/billing/budget") ? json(BUDGET) : json({}, 404))),
      cfg,
      db,
    );
    expect(res.a?.vibe).toEqual({ used: 10, initial: 100, source: "mistral" });
    expect(res.a?.api).toEqual({ used: 5, initial: 10, source: "mistral" });
    const snap = must(db.latestSnapshot("a", "api"));
    expect(snap.used_eur).toBe(5);
    expect(snap.initial_eur).toBe(10);
  });
  it("skips a pool with a bad budget payload and keeps syncing", async () => {
    const db = openDb(":memory:");
    const cfg = defaultConfig();
    cfg.accounts.push(acct("a", { vibe: "k" }), acct("b", { vibe: "k" }));
    let n = 0;
    const res = await syncAll(
      fakeFetch((url) => {
        if (!url.endsWith("/v1/billing/budget")) return json({}, 404);
        n += 1;
        return n === 1 ? json({ vibe_budget: { initial_budget: null, usage_percentage: "x" } }) : json(BUDGET);
      }),
      cfg,
      db,
    );
    expect(res.a?.vibe).toBeUndefined();
    expect(res.b?.vibe).toEqual({ used: 10, initial: 100, source: "mistral" });
  });
  it("tries account keys vibe-first and falls through on errors", async () => {
    const db = openDb(":memory:");
    const cfg = defaultConfig();
    cfg.accounts.push(acct("a", { vibe: "bad-key", api: "good-key" }));
    const calls: { url: string; auth: string | null }[] = [];
    const res = await syncAll(
      fakeFetch((_url, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        return auth.endsWith("bad-key") ? json({ message: "no" }, 401) : json(BUDGET);
      }, calls),
      cfg,
      db,
    );
    expect(calls.map((c) => c.auth)).toEqual(["Bearer bad-key", "Bearer good-key"]);
    expect(res.a?.vibe?.source).toBe("mistral");
  });
  it("falls back to manual budgets when no key works", async () => {
    const db = openDb(":memory:");
    const cfg = defaultConfig();
    cfg.accounts.push(acct("a", {}, { vibe: { initial_eur: 50, reset_day: 15 } }));
    const res = await syncAll(
      fakeFetch(() => json({}, 404)),
      cfg,
      db,
    );
    expect(res.a?.vibe?.source).toBe("manual");
    expect(res.a?.vibe?.initial).toBe(50);
    const snap = must(db.latestSnapshot("a", "vibe"));
    expect(snap.initial_eur).toBe(50);
    expect(snap.used_eur).toBe(0);
  });
  it("manual fallback does not double count spending booked during the fetch", async () => {
    const db = openDb(":memory:");
    const cfg = defaultConfig();
    cfg.accounts.push(acct("a", { vibe: "k" }, { vibe: { initial_eur: 50, reset_day: 15 } }));
    await syncAll(
      fakeFetch(async () => {
        await new Promise((r) => setTimeout(r, 20));
        db.addLedger({ ts: Date.now() / 1000, account: "a", pool: "vibe", cost_eur: 1, source: "proxy" });
        return json({}, 404);
      }),
      cfg,
      db,
    );
    const s = must(createBudgetEngine(db, cfg.limits).status("a", "vibe", Date.now() / 1000 + 1));
    expect(s.used).toBeCloseTo(1, 6);
  });
  it("books the external gap only for the canonical account", async () => {
    const db = openDb(":memory:");
    db.links.set("b", "a");
    const now = Date.now() / 1000;
    const prev = {
      ts: now - 60,
      pool: "vibe",
      initial_eur: 100,
      reset_at: parseIso("2099-01-01T00:00:00Z"),
      currency: "EUR",
    };
    db.addSnapshot({ ...prev, account: "a", used_eur: 5 });
    db.addSnapshot({ ...prev, account: "b", used_eur: 10 });
    db.addLedger({ ts: now - 30, account: "a", pool: "vibe", cost_eur: 3, source: "proxy" });
    const cfg = defaultConfig();
    cfg.accounts.push(acct("a", { vibe: "k" }), acct("b", { vibe: "k" }));
    await syncAll(
      fakeFetch(() => json(BUDGET)),
      cfg,
      db,
    );
    const rows = db.recent().filter((r) => r.source === "sync");
    expect(rows.length).toBe(1);
    const row = must(rows[0]);
    expect(row.account).toBe("a");
    expect(row.client).toBe("(external)");
    expect(Math.abs(row.cost_eur - (5 - 3))).toBeLessThan(0.001);
  });
  it("does not book a gap for linked members", async () => {
    const db = openDb(":memory:");
    db.links.set("b", "a");
    const now = Date.now() / 1000;
    db.addSnapshot({
      ts: now - 60,
      account: "b",
      pool: "vibe",
      used_eur: 10,
      initial_eur: 100,
      reset_at: parseIso("2099-01-01T00:00:00Z"),
      currency: "EUR",
    });
    const cfg = defaultConfig();
    cfg.accounts.push(acct("b", { vibe: "k" }));
    await syncAll(
      fakeFetch(() => json(BUDGET)),
      cfg,
      db,
    );
    expect(db.recent().filter((r) => r.source === "sync").length).toBe(0);
  });
});

describe("checkKey", () => {
  it("reports budgets for a valid key", async () => {
    const r = await checkKey(
      fakeFetch((url) => (url.endsWith("/v1/billing/budget") ? json(BUDGET) : json({}, 404))),
      "https://api.mistral.ai",
      "good",
    );
    expect(r.valid).toBe(true);
    expect(r.budgets?.vibe).toEqual({ initial: 100, used: 10, currency: "EUR" });
  });
  it("never follows redirects and treats them as a failed check", async () => {
    const modes: (string | undefined)[] = [];
    const r = await checkKey(
      fakeFetch((_url, init) => {
        modes.push(init?.redirect);
        return new Response(null, { status: 307, headers: { location: "http://127.0.0.1:1/x" } });
      }),
      "https://api.mistral.ai",
      "k",
    );
    expect(r.valid).toBe(false);
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every((m) => m === "manual")).toBe(true);
  });
  it("falls back to a model list when billing is off-limits", async () => {
    const r = await checkKey(
      fakeFetch((url) => (url.endsWith("/v1/billing/budget") ? json({}, 403) : json({ data: [] }))),
      "https://api.mistral.ai",
      "limited",
    );
    expect(r.valid).toBe(true);
    expect(r.note).toBe("The key works, but it cannot read the budget overview.");
  });
  it("rejects a key both endpoints refuse", async () => {
    const r = await checkKey(
      fakeFetch((url) => json({}, url.endsWith("/v1/billing/budget") ? 401 : 401)),
      "https://api.mistral.ai",
      "bad",
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe("Mistral rejected the key (401).");
  });
  it("reports other upstream statuses", async () => {
    const r = await checkKey(
      fakeFetch(() => json({}, 500)),
      "https://api.mistral.ai",
      "k",
    );
    expect(r.valid).toBe(false);
    expect(r.error).toBe("Mistral returned an error (500).");
  });
  it("reports network failures", async () => {
    const r = await checkKey(
      fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
      "https://api.mistral.ai",
      "k",
    );
    expect(r.valid).toBe(false);
    expect(r.error).toContain("Could not reach Mistral");
  });
});

describe("manual budget window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("reset day 31 on Feb 3 counts spending since Jan 31 only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2030, 1, 3, 12)));
    const db = openDb(":memory:");
    const cfg = defaultConfig();
    cfg.accounts.push(acct("a", {}, { vibe: { initial_eur: 50, reset_day: 31 } }));
    db.addLedger({ ts: Date.UTC(2030, 0, 29, 12) / 1000, account: "a", pool: "vibe", cost_eur: 4, source: "proxy" });
    db.addLedger({ ts: Date.UTC(2030, 0, 31, 12) / 1000, account: "a", pool: "vibe", cost_eur: 1, source: "proxy" });
    const res = await syncAll(
      fakeFetch(() => json({}, 404)),
      cfg,
      db,
    );
    expect(res.a?.vibe?.used).toBe(1);
  });
});

describe("reset math and the loop", () => {
  it("nextReset clamps the day and rolls the month", () => {
    const feb10 = Date.UTC(2030, 1, 10) / 1000;
    expect(nextReset(15, feb10)).toBe(Date.UTC(2030, 1, 15) / 1000);
    expect(nextReset(5, feb10)).toBe(Date.UTC(2030, 2, 5) / 1000);
    expect(nextReset(31, feb10)).toBe(Date.UTC(2030, 1, 28) / 1000);
    expect(nextReset(31, Date.UTC(2030, 11, 31, 12) / 1000)).toBe(Date.UTC(2031, 0, 31) / 1000);
  });
  it("prevReset clamps the configured day to the previous month, not the clamped reset date", () => {
    expect(prevReset(31, Date.UTC(2030, 1, 28) / 1000)).toBe(Date.UTC(2030, 0, 31) / 1000);
    expect(prevReset(31, Date.UTC(2030, 2, 31) / 1000)).toBe(Date.UTC(2030, 1, 28) / 1000);
    expect(prevReset(15, Date.UTC(2030, 0, 15) / 1000)).toBe(Date.UTC(2029, 11, 15) / 1000);
  });
  it("parseIso handles Z and offsets", () => {
    expect(parseIso("2099-01-01T00:00:00Z")).toBe(Date.UTC(2099, 0, 1) / 1000);
    expect(parseIso("2099-01-01T01:00:00+01:00")).toBe(Date.UTC(2099, 0, 1) / 1000);
  });
  it("the sync loop syncs, clears blocks and stops", async () => {
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    cfg.limits.sync_interval_s = 3600;
    cfg.accounts.push(acct("a", { vibe: "k" }));
    const st = createState(
      cfg,
      fakeFetch((url) => (url.endsWith("/v1/billing/budget") ? json(BUDGET) : json({}, 404))),
    );
    st.blockedUntil.set("x", 1);
    const stop = startSyncLoop(st);
    await waitFor(() => st.lastSync > 0);
    expect(st.blockedUntil.size).toBe(0);
    stop();
  });
  it("keeps spending booked while the fetch is in flight and an account named __proto__", async () => {
    const db = openDb(":memory:");
    const cfg = defaultConfig();
    cfg.accounts.push(acct("__proto__", { vibe: "vibe-key" }));
    const zero = {
      vibe_budget: { usage_percentage: 0, initial_budget: 100, reset_at: "2099-01-01T00:00:00Z", currency: "EUR" },
    };
    const res = await syncAll(
      fakeFetch(async () => {
        await new Promise((r) => setTimeout(r, 30));
        db.addLedger({ ts: Date.now() / 1000, account: "__proto__", pool: "vibe", cost_eur: 1, source: "proxy" });
        return json(zero);
      }),
      cfg,
      db,
    );
    expect(Object.keys(res)).toEqual(["__proto__"]);
    const snap = must(db.latestSnapshot("__proto__", "vibe"));
    expect(snap.used_eur + db.costBetween("__proto__", "vibe", snap.ts)).toBeCloseTo(1, 9);
  });
});
