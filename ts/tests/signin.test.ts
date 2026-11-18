import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SignInAttempt, SignInStatus } from "../shared/api.ts";
import { defaultConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createSignIn, pkcePair, type SignInApi, SignInError } from "../src/signin.ts";
import { createStore } from "../src/store.ts";
import type { Config, FetchLike } from "../src/types.ts";
import { must } from "./helpers.ts";

process.env.MISTWATCH_NO_KEYRING = "1";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
type Server = {
  challenge?: string | undefined;
  polls?: number | undefined;
  final?: Record<string, unknown> | undefined;
  expires?: string | undefined;
  signInUrl?: string | undefined;
  exchangeStatus?: number | undefined;
};
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const body = (init: RequestInit | undefined): Record<string, unknown> => {
  const b = init?.body;
  const raw = b instanceof Uint8Array ? new TextDecoder().decode(b) : typeof b === "string" ? b : "";
  const p: unknown = JSON.parse(raw);
  return isRec(p) ? p : {};
};
const makeHandler =
  (s: Server): Handler =>
  (url, init) => {
    if (url === "https://console.mistral.ai/api/vibe/sign-in") {
      const b = body(init);
      s.challenge = typeof b.code_challenge === "string" ? b.code_challenge : undefined;
      expect(b.code_challenge_method).toBe("S256");
      return json({
        process_id: "p1",
        sign_in_url: s.signInUrl ?? "https://console.mistral.ai/vibe/sign-in/p1",
        poll_url: "https://console.mistral.ai/api/vibe/sign-in/p1/poll",
        expires_at: s.expires ?? "2099-01-01T00:00:00Z",
      });
    }
    if (url.endsWith("/poll")) {
      s.polls = (s.polls ?? 0) + 1;
      if (s.polls < 3) return json({ status: "pending" });
      return json(s.final ?? { status: "completed", exchange_token: "xt" });
    }
    if (url.endsWith("/exchange")) {
      const b = body(init);
      expect(b.exchange_token).toBe("xt");
      const digest = createHash("sha256")
        .update(typeof b.code_verifier === "string" ? b.code_verifier : "", "ascii")
        .digest("base64url");
      expect(digest).toBe(s.challenge);
      if (s.exchangeStatus) return json({ error_code: 9004 }, s.exchangeStatus);
      return json({ api_key: "signed-in-key-123456" });
    }
    if (url.endsWith("/v1/billing/budget"))
      return json({
        vibe_budget: { usage_percentage: 20, initial_budget: 100, reset_at: "2099-01-01T00:00:00Z", currency: "EUR" },
      });
    return new Response("not found", { status: 404 });
  };
const fakeFetch = (h: Handler): FetchLike => {
  const f: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(h(url, init));
  };
  return f;
};
const mk = (server: Server): { signin: SignInApi; cfg: Config; synced: { v: boolean } } => {
  const db = openDb(":memory:");
  const store = createStore(db);
  store.createAccount("me@example.cz");
  const cfg = defaultConfig();
  cfg.db_path = ":memory:";
  cfg.accounts.splice(0, 0, ...store.listAccounts());
  const synced = { v: false };
  const signin = createSignIn({
    cfg,
    db,
    store,
    fetch: fakeFetch(makeHandler(server)),
    blockedUntil: new Map(),
    onSynced: () => {
      synced.v = true;
    },
    pollIntervalS: 0.01,
  });
  return { signin, cfg, synced };
};
const wait = async (signin: SignInApi, id: string, want: SignInStatus[], ms = 5000): Promise<SignInAttempt> => {
  const end = Date.now() + ms;
  for (;;) {
    const a = signin.get(id);
    if (a && want.includes(a.status)) return a;
    if (Date.now() > end) throw new Error(`timeout, last status ${a?.status ?? "missing"}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("sign-in flow", () => {
  it("pkce pair matches sha256", () => {
    const [v, ch] = pkcePair();
    expect(ch).toBe(createHash("sha256").update(v, "ascii").digest("base64url"));
  });
  it("full flow stores the key and syncs", async () => {
    const server: Server = {};
    const { signin, cfg, synced } = mk(server);
    const a = await signin.start("me@example.cz", "vibe");
    expect(a.status).toBe("pending");
    expect(a.sign_in_url.startsWith("https://console.mistral.ai/")).toBe(true);
    const s = await wait(signin, a.id, ["done", "error"]);
    expect(s.status).toBe("done");
    expect(s.synced.vibe?.initial).toBe(100);
    const acct = must(cfg.accounts.find((x) => x.name === "me@example.cz"));
    expect(acct.keys.vibe).toBe("signed-in-key-123456");
    expect(JSON.stringify(signin.get(a.id) ?? {})).not.toContain("signed-in-key-123456");
    expect(synced.v).toBe(true);
  });
  it("never follows redirects and treats a 3xx as failure", async () => {
    const seen: RequestInit["redirect"][] = [];
    const db = openDb(":memory:");
    const store = createStore(db);
    store.createAccount("me@example.cz");
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    cfg.accounts.splice(0, 0, ...store.listAccounts());
    const signin = createSignIn({
      cfg,
      db,
      store,
      fetch: fakeFetch((_url, init) => {
        seen.push(init?.redirect);
        return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      }),
      blockedUntil: new Map(),
      onSynced: () => undefined,
      pollIntervalS: 0.01,
    });
    await expect(signin.start("me@example.cz", "vibe")).rejects.toBeInstanceOf(SignInError);
    expect(seen).toEqual(["manual"]);
  });
  it("sends manual redirect mode on poll and exchange requests", async () => {
    const modes: RequestInit["redirect"][] = [];
    const h = makeHandler({});
    const db = openDb(":memory:");
    const store = createStore(db);
    store.createAccount("me@example.cz");
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    cfg.accounts.splice(0, 0, ...store.listAccounts());
    const signin = createSignIn({
      cfg,
      db,
      store,
      fetch: fakeFetch((url, init) => {
        if (/sign-in|poll|exchange/.test(url)) modes.push(init?.redirect);
        return h(url, init);
      }),
      blockedUntil: new Map(),
      onSynced: () => undefined,
      pollIntervalS: 0.01,
    });
    const a = await signin.start("me@example.cz", "vibe");
    await wait(signin, a.id, ["done", "error"]);
    expect(modes.length).toBeGreaterThanOrEqual(4);
    expect(modes.every((m) => m === "manual")).toBe(true);
  });
  it("maps denied, expired and error end states", async () => {
    for (const [final, want] of [
      [{ status: "denied" }, "denied"],
      [{ status: "expired" }, "expired"],
      [{ status: "error", message: "boom" }, "error"],
    ] as [Record<string, unknown>, SignInStatus][]) {
      const server: Server = { final };
      const { signin } = mk(server);
      const a = await signin.start("me@example.cz", "vibe");
      const s = await wait(signin, a.id, [want]);
      expect(s.status).toBe(want);
    }
  });
  it("surfaces the workspace-denied message", async () => {
    const server: Server = { exchangeStatus: 403 };
    const { signin } = mk(server);
    const a = await signin.start("me@example.cz", "vibe");
    const s = await wait(signin, a.id, ["error"]);
    expect(s.message.toLowerCase()).toContain("workspace");
  });
  it("rejects foreign and non-https sign-in urls", async () => {
    const { signin } = mk({ signInUrl: "https://evil.example.com/steal" });
    await expect(signin.start("me@example.cz", "vibe")).rejects.toBeInstanceOf(SignInError);
    const { signin: s2 } = mk({ signInUrl: "http://console.mistral.ai/vibe/sign-in/p1" });
    await expect(s2.start("me@example.cz", "vibe")).rejects.toBeInstanceOf(SignInError);
  });
  it("cancels a pending attempt", async () => {
    const { signin } = mk({ final: { status: "pending" } });
    const a = await signin.start("me@example.cz", "vibe");
    expect(signin.cancel(a.id)).toBe(true);
    expect(must(signin.get(a.id)).status).toBe("cancelled");
    expect(signin.cancel("nope")).toBe(false);
    expect(signin.get("nope")).toBeUndefined();
  });
  it("replaces an active attempt for the same account and pool", async () => {
    const { signin } = mk({ final: { status: "pending" } });
    const a1 = await signin.start("me@example.cz", "vibe");
    const a2 = await signin.start("me@example.cz", "vibe");
    expect(must(signin.get(a1.id)).status).toBe("cancelled");
    expect(must(signin.get(a2.id)).status).toBe("pending");
  });
  it("caps active attempts", async () => {
    const { signin } = mk({ final: { status: "pending" } });
    const combos: [string, "vibe" | "api"][] = [
      ["a1", "vibe"],
      ["a2", "vibe"],
      ["a3", "vibe"],
      ["a4", "vibe"],
      ["a1", "api"],
    ];
    for (const [acc, pool] of combos) await signin.start(acc, pool);
    await expect(signin.start("a9", "vibe")).rejects.toThrow("Too many sign-ins in progress.");
  });
  it("reserves capacity for concurrent starts", async () => {
    const { signin } = mk({ final: { status: "pending" } });
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => signin.start(`c${i}`, "vibe")));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(res.filter((r) => r.status === "rejected")).toHaveLength(3);
  });
  it("keeps only one concurrent start per account and pool", async () => {
    const { signin } = mk({ final: { status: "pending" } });
    const res = await Promise.allSettled([
      signin.start("me@example.cz", "vibe"),
      signin.start("me@example.cz", "vibe"),
    ]);
    expect(res.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });
  it("does not finish as done when cancelled during the post-exchange sync", async () => {
    const db = openDb(":memory:");
    const store = createStore(db);
    store.createAccount("me@example.cz");
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    cfg.accounts.splice(0, 0, ...store.listAccounts());
    const h = makeHandler({});
    let cancel: () => void = () => undefined;
    const signin = createSignIn({
      cfg,
      db,
      store,
      fetch: fakeFetch((url, init) => {
        if (url.endsWith("/v1/billing/budget")) cancel();
        return h(url, init);
      }),
      blockedUntil: new Map(),
      pollIntervalS: 0.01,
    });
    const a = await signin.start("me@example.cz", "vibe");
    cancel = () => signin.cancel(a.id);
    await wait(signin, a.id, ["cancelled"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(must(signin.get(a.id)).status).toBe("cancelled");
  });
  it("marks an already-expired attempt as expired", async () => {
    const { signin } = mk({ expires: "2000-01-01T00:00:00Z" });
    const a = await signin.start("me@example.cz", "vibe");
    const s = await wait(signin, a.id, ["expired"]);
    expect(s.status).toBe("expired");
  });
  it("turns repeated poll failures into an error", async () => {
    const server: Server = {};
    const db = openDb(":memory:");
    const store = createStore(db);
    store.createAccount("me@example.cz");
    const cfg = defaultConfig();
    cfg.accounts.splice(0, 0, ...store.listAccounts());
    const signin = createSignIn({
      cfg,
      db,
      store,
      fetch: fakeFetch((url, init) =>
        url.endsWith("/poll") ? json({ nope: 1 }, 500) : makeHandler(server)(url, init),
      ),
      pollIntervalS: 0.005,
    });
    const a = await signin.start("me@example.cz", "vibe");
    const s = await wait(signin, a.id, ["error"]);
    expect(s.message).toBe("Could not check the sign-in status.");
  });
});
