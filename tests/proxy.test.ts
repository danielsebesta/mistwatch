import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import { createProxy } from "../src/proxy.ts";
import { blockKey, createState, exhaustedInfo, type State } from "../src/state.ts";
import type { Account, Config, FetchLike } from "../src/types.ts";
import { must } from "./helpers.ts";

process.env.MISTWATCH_NO_KEYRING = "1";

type Call = { url: string; init: RequestInit | undefined };
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const calls: Call[] = [];
const fakeFetch = (h: Handler): FetchLike => {
  const f: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(h(url, init));
  };
  return f;
};
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const enc = new TextEncoder();
const okJson = (): Response =>
  json({ model: "mistral-large-4-0", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
const SSE =
  'data: {"model":"mistral-large-4-0","choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: {"model":"mistral-large-4-0","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\n' +
  "data: [DONE]\n\n";
const abortable = <T>(p: Promise<T>, s: AbortSignal | null | undefined): Promise<T> =>
  s === null || s === undefined
    ? p
    : Promise.race([
        p,
        new Promise<never>((_ok, rej) => {
          if (s.aborted) rej(s.reason);
          else s.addEventListener("abort", () => rej(s.reason), { once: true });
        }),
      ]);
const gated = (): [Promise<void>, () => void] => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((ok) => {
    release = ok;
  });
  return [gate, release];
};
const acct = (name = "a", keys: Record<string, string> = { vibe: "vibe-key", api: "api-key" }): Account => ({
  name,
  keys,
  priority: 100,
  enabled: true,
  manual: {},
});
const mkCfg = (accounts: Account[], withClient = true): Config => {
  const c = defaultConfig();
  c.db_path = ":memory:";
  c.usd_to_eur = 1.0;
  c.router.llm_classifier = false;
  c.accounts.push(...accounts);
  if (withClient) c.clients.push({ name: "t", token: "tok" });
  return c;
};
const seedPool = (st: State, account: string, pool: string, used: number, initial: number, days = 14): void => {
  const now = Date.now() / 1000;
  st.db.addSnapshot({
    ts: now,
    account,
    pool,
    used_eur: used,
    initial_eur: initial,
    reset_at: now + days * 86400,
    currency: "EUR",
  });
};
const req = (path: string, init: RequestInit = {}): Request => {
  const h = new Headers(init.headers);
  h.set("host", "localhost:8787");
  return new Request(`http://localhost:8787${path}`, { ...init, headers: h });
};
const jreq = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const AUTH = { authorization: "Bearer tok" };
const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  for (;;) {
    if (cond()) return;
    if (Date.now() > end) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const errType = async (r: Response): Promise<string> => {
  const b: unknown = await r.json();
  const t = isRec(b) && isRec(b.error) ? b.error.type : undefined;
  if (typeof t !== "string") throw new Error("not an error body");
  return t;
};
const baseState = (handler: Handler): State => {
  calls.length = 0;
  const st = createState(mkCfg([acct()]), fakeFetch(handler));
  seedPool(st, "a", "api", 0, 12.75);
  seedPool(st, "a", "vibe", 127.5, 127.5);
  return st;
};
const bodyOf = (init: RequestInit | undefined): unknown => {
  const b = init?.body;
  const raw = b instanceof Uint8Array ? b : typeof b === "string" ? enc.encode(b) : new Uint8Array(0);
  return JSON.parse(new TextDecoder().decode(raw));
};

describe("proxy auth and local checks", () => {
  it("rejects without a valid key once keys exist", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "x" }));
    expect(r.status).toBe(401);
    expect(await errType(r)).toBe("mistwatch_auth");
    const r2 = await p.handle(jreq("/v1/chat/completions", { model: "x" }, { authorization: "Bearer nope" }));
    expect(r2.status).toBe(401);
  });
  it("is open when no proxy keys exist", async () => {
    calls.length = 0;
    const st = createState(
      mkCfg([acct()], false),
      fakeFetch(() => okJson()),
    );
    seedPool(st, "a", "api", 0, 12.75);
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0" }));
    expect(r.status).toBe(200);
  });
  it("rejects foreign Host and Origin headers", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st);
    const r = await p.handle(
      new Request("http://localhost:8787/v1/chat/completions", {
        method: "POST",
        headers: { host: "evil.example.com", authorization: "Bearer tok" },
        body: "{}",
      }),
    );
    expect(r.status).toBe(403);
    const r2 = await p.handle(
      jreq("/v1/chat/completions", { model: "x" }, { ...AUTH, origin: "https://evil.example.com" }),
    );
    expect(r2.status).toBe(403);
  });
  it("returns 404 JSON for unknown /api paths instead of forwarding", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st);
    const r = await p.handle(req("/api/definitely-not-a-route", { headers: AUTH }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: "Not Found" });
    expect(calls.length).toBe(0);
  });
});

describe("proxy forwarding", () => {
  it("books cost and swaps in the pool key", async () => {
    const st = baseState((url, init) => {
      expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer api-key");
      expect(h.get("cookie")).toBeNull();
      expect(h.get("x-mw")).toBeNull();
      return okJson();
    });
    const p = createProxy(st);
    const r = await p.handle(
      jreq("/v1/chat/completions", { model: "mistral-large-4-0", messages: [] }, { ...AUTH, "user-agent": "curl" }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("x-mw-pool")).toBe("api");
    expect(r.headers.get("x-mw-account")).toBe("a");
    expect(r.headers.get("x-mw-room-eur")).toMatch(/^-?\d+\.\d{4}$/);
    const rows = st.db.recent();
    expect(rows.length).toBe(1);
    const row = must(rows[0]);
    expect(Math.abs(row.cost_eur - (1000 * 0.7 + 500 * 2.1) / 1e6)).toBeLessThan(1e-9);
    expect(row.client).toBe("t");
    expect(row.model).toBe("mistral-large-4-0");
  });
  it("accepts x-api-key auth as well", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "m" }, { "x-api-key": "tok" }));
    expect(r.status).toBe(200);
  });
  it("streams SSE and books the usage chunk", async () => {
    const st = baseState(
      () => new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "x=1" } }),
    );
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    const text = await r.text();
    expect(text).toContain("[DONE]");
    const row = must(st.db.recent()[0]);
    expect(row.prompt_tokens).toBe(1000);
    expect(row.completion_tokens).toBe(500);
    expect(row.estimated).toBe(0);
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
  });
  it("estimates tokens when the stream has no usage", async () => {
    const st = baseState(() => new Response('data: {"choices":[{"delta":{"content":"hello!"}}]}\n\ndata: [DONE]\n\n'));
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH));
    await r.text();
    const row = must(st.db.recent()[0]);
    expect(row.estimated).toBe(1);
    expect(row.completion_tokens).toBe(1);
  });
  it("books a final usage chunk that has no trailing newline", async () => {
    const st = baseState(
      () => new Response('data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}'),
    );
    const r = await createProxy(st).handle(
      jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH),
    );
    await r.text();
    const row = must(st.db.recent()[0]);
    expect(row.completion_tokens).toBe(500);
    expect(row.estimated).toBe(0);
  });
  it("releases the reservation when the final chunk is malformed", async () => {
    const st = baseState(() => new Response('data: {"usage":{"prompt_tokens":"broken","completion_tokens":1}}'));
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH));
    await r.text();
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
    const r2 = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH));
    expect(r2.status).toBe(200);
    await r2.text();
  });
  it("skips an account whose key is not a valid header value", async () => {
    const st = baseState(() => okJson());
    st.cfg.accounts[0] = acct("a", { vibe: "bad​key", api: "bad​key" });
    const r = await createProxy(st).handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, AUTH));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
  });
  it("books partial usage when the client disconnects mid-stream", async () => {
    const st = baseState(
      () =>
        new Response(
          (() => {
            let sent = false;
            return new ReadableStream<Uint8Array>({
              pull(c) {
                if (sent) return new Promise<void>(() => undefined);
                sent = true;
                c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial text"}}]}\n\n'));
                c.enqueue(enc.encode("data: {never-finished"));
                return undefined;
              },
            });
          })(),
        ),
    );
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH));
    const body = must(r.body);
    await body.cancel();
    await waitFor(() => st.db.recent().length === 1);
    const row = must(st.db.recent()[0]);
    expect(row.estimated).toBe(1);
    expect(row.completion_tokens).toBe(3);
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
  });
  it("books an aborted stream when the request signal fires", async () => {
    const st = baseState(
      (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
              return new Promise<void>((_ok, rej) => {
                const s = init?.signal;
                if (s === null || s === undefined) return;
                if (s.aborted) rej(s.reason);
                else s.addEventListener("abort", () => rej(s.reason), { once: true });
              });
            },
          }),
        ),
    );
    const p = createProxy(st);
    const ctrl = new AbortController();
    const r = await p.handle(
      req("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({ model: "mistral-large-4-0", stream: true }),
        signal: ctrl.signal,
      }),
    );
    const body = must(r.body);
    const reader = body.getReader();
    await reader.read();
    ctrl.abort();
    await waitFor(() => st.db.recent().length === 1);
    expect(must(st.db.recent()[0]).estimated).toBe(1);
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
  });
  it("falls back to the other pool for a Vibe user agent", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st);
    const r = await p.handle(
      jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, { ...AUTH, "user-agent": "Mistral-Vibe/3.1.0" }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("x-mw-pool")).toBe("api");
    expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toBe("Mistral-Vibe/3.1.0");
  });
  it("forwards non-accounted paths with the first key and books nothing", async () => {
    const st = baseState(() => json({ data: [] }));
    const p = createProxy(st);
    const r = await p.handle(req("/v1/models?x=1", { headers: AUTH }));
    expect(r.status).toBe(200);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer vibe-key");
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/models?x=1");
    expect(st.db.recent().length).toBe(0);
  });
  it("only accounts exact path segments", async () => {
    const st = baseState(() => json({ ok: true }));
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/ocr-anything", { model: "x" }, AUTH));
    expect(r.status).toBe(200);
    expect(st.db.recent().length).toBe(0);
  });
});

describe("proxy budget gate and retries", () => {
  it("returns mistwatch_budget_exhausted with Retry-After when all pools are spent", async () => {
    calls.length = 0;
    const st = createState(
      mkCfg([acct()]),
      fakeFetch(() => okJson()),
    );
    seedPool(st, "a", "api", 12.75, 12.75);
    seedPool(st, "a", "vibe", 127.5, 127.5);
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await errType(r)).toBe("mistwatch_budget_exhausted");
  });
  it("does not let concurrent requests overspend", async () => {
    calls.length = 0;
    const [gate, release] = gated();
    const st = createState(
      mkCfg([acct("a", { api: "api-key" })]),
      fakeFetch(async () => {
        await gate;
        return okJson();
      }),
    );
    seedPool(st, "a", "api", 0, 0.1);
    const p = createProxy(st);
    const r1 = p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, AUTH));
    await waitFor(() => calls.length === 1);
    const r2 = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, AUTH));
    expect(r2.status).toBe(429);
    expect(await errType(r2)).toBe("mistwatch_budget_exhausted");
    release();
    const res1 = await r1;
    expect(res1.status).toBe(200);
    expect(st.db.recent().length).toBe(1);
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
  });
  it("blocks a pool after an upstream 401 and surfaces the last upstream answer", async () => {
    calls.length = 0;
    const st = createState(
      mkCfg([acct("a", { api: "api-key" })]),
      fakeFetch(() => json({ error: "denied" }, 401)),
    );
    seedPool(st, "a", "api", 0, 12.75);
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r.status).toBe(401);
    const r2 = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r2.status).toBe(429);
    expect(await errType(r2)).toBe("mistwatch_budget_exhausted");
    expect(calls.length).toBe(1);
  });
  it("falls through to the next candidate after an upstream 429", async () => {
    calls.length = 0;
    const seen: string[] = [];
    const st = createState(
      mkCfg([acct("a", { vibe: "vibe-key", api: "api-key" })]),
      fakeFetch((_u, i) => {
        const auth = new Headers(i?.headers).get("authorization") ?? "";
        seen.push(auth);
        return auth.endsWith("vibe-key") ? json({ error: "slow" }, 429) : okJson();
      }),
    );
    seedPool(st, "a", "api", 0, 12.75);
    seedPool(st, "a", "vibe", 0, 127.5);
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "m" }, { ...AUTH, "user-agent": "Mistral-Vibe/1" }));
    expect(r.status).toBe(200);
    expect(seen).toEqual(["Bearer vibe-key", "Bearer api-key"]);
    expect(must(st.blockedUntil.get(blockKey("a", "vibe")))).toBeGreaterThan(0);
  });
  it("retries a connect failure on the next candidate but not post-send failures", async () => {
    calls.length = 0;
    let n = 0;
    const st = createState(
      mkCfg([acct("a1", { api: "k1" }), acct("a2", { api: "k2" })]),
      fakeFetch((_u, i) => {
        n += 1;
        const auth = new Headers(i?.headers).get("authorization") ?? "";
        if (auth.endsWith("k1"))
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        return okJson();
      }),
    );
    seedPool(st, "a1", "api", 0, 12.75);
    seedPool(st, "a2", "api", 0, 12.75);
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r.status).toBe(200);
    expect(n).toBe(2);
  });
  it("does not retry unknown failures after send", async () => {
    calls.length = 0;
    const st = createState(
      mkCfg([acct("a1", { api: "k1" }), acct("a2", { api: "k2" })]),
      fakeFetch(() => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_OTHER" } });
      }),
    );
    seedPool(st, "a1", "api", 0, 12.75);
    seedPool(st, "a2", "api", 0, 12.75);
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r.status).toBe(502);
    expect(calls.length).toBe(1);
  });
});

describe("proxy routing, limits and shutdown", () => {
  it("routes auto models and exposes the decision header", async () => {
    calls.length = 0;
    let upstreamModel = "";
    const st = baseState((_u, init) => {
      const body = bodyOf(init);
      if (isRec(body)) upstreamModel = typeof body.model === "string" ? body.model : "";
      return okJson();
    });
    const p = createProxy(st);
    const r = await p.handle(
      jreq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }, AUTH),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("x-mw-routed")).toContain("mistral-small-2603");
    expect(upstreamModel).toBe("mistral-small-2603");
  });
  it("tries the free GLM Flash on the Vibe pool only and falls back to the paid one for a while", async () => {
    const seen: string[] = [];
    const st = baseState((_u, init) => {
      const b = bodyOf(init);
      const m = isRec(b) && typeof b.model === "string" ? b.model : "";
      if (m === "ministral-3b-latest") {
        return json({
          choices: [{ message: { content: '{"difficulty": 5}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        });
      }
      seen.push(m);
      return m === "zai-glm-5-3-flash-vibe-free" ? new Response("{}", { status: 429 }) : okJson();
    });
    seedPool(st, "a", "vibe", 0, 127.5);
    const p = createProxy(st);
    const ask = (n: number, ua = "Mistral-Vibe/3.1.0") =>
      p.handle(
        jreq(
          "/v1/chat/completions",
          { model: "auto", messages: [{ role: "user", content: `explain feature number ${n} of this module` }] },
          { ...AUTH, "user-agent": ua },
        ),
      );
    const r0 = await ask(0, "other-client/1");
    expect(r0.headers.get("x-mw-pool")).toBe("api");
    expect(seen).toEqual(["zai-glm-5-3-flash"]);
    seen.length = 0;
    const r1 = await ask(1);
    expect(r1.status).toBe(200);
    expect(seen).toEqual(["zai-glm-5-3-flash-vibe-free", "zai-glm-5-3-flash"]);
    const r2 = await ask(2);
    expect(r2.status).toBe(200);
    expect(seen).toEqual(["zai-glm-5-3-flash-vibe-free", "zai-glm-5-3-flash", "zai-glm-5-3-flash"]);
  });
  it("lets a stream that keeps sending data outlive the total timeout", async () => {
    const chunk = (t: string): Uint8Array =>
      enc.encode(`data: {"model":"mistral-large-4-0","choices":[{"delta":{"content":"${t}"}}]}\n\n`);
    const st = baseState(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              for (let i = 0; i < 8; i++) {
                c.enqueue(chunk(String(i)));
                await new Promise((ok) => setTimeout(ok, 60));
              }
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const p = createProxy(st, { totalTimeoutS: 0.25 });
    const r = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH));
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("[DONE]");
  });
  it("answers the Vibe billing budget and the limit windows itself", async () => {
    const st = baseState(() => okJson());
    seedPool(st, "a", "vibe", 25.5, 127.5);
    const p = createProxy(st);
    const b = await p.handle(req("/v1/billing/budget", { headers: AUTH }));
    expect(b.status).toBe(200);
    const vb = (await b.json()) as { vibe_budget: { usage_percentage: number; initial_budget: number } };
    expect(vb.vibe_budget.usage_percentage).toBe(20);
    expect(vb.vibe_budget.initial_budget).toBe(127.5);
    expect(calls.length).toBe(0);
    const l = await p.handle(req("/v1/mistwatch/limits", { headers: AUTH }));
    const lj = (await l.json()) as { pools: { pool: string; windows: Record<string, unknown> }[] };
    expect(lj.pools.map((x) => x.pool).sort()).toEqual(["api", "vibe"]);
    expect(Object.keys(lj.pools[0]?.windows ?? {}).sort()).toEqual(["5h", "day", "week"]);
  });
  it("answers /v1/users/me with the Mistwatch user", async () => {
    const st = baseState(() => okJson());
    st.store.createUser("daniel", "correct horse battery");
    const r = await createProxy(st).handle(req("/v1/users/me", { headers: AUTH }));
    expect(await r.json()).toMatchObject({ first_name: "daniel" });
    expect(calls.length).toBe(0);
  });
  it("adds the limit windows to accounted responses", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st);
    const r = await p.handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, AUTH));
    expect(r.headers.get("x-mw-limits")).toMatch(/5h=.*day=.*week=.*month=/);
  });
  it("rejects oversize bodies with 413", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st, { bodyLimit: 64 });
    const r = await p.handle(jreq("/v1/chat/completions", { model: "x".padEnd(200, "x") }, AUTH));
    expect(r.status).toBe(413);
    expect(await errType(r)).toBe("mistwatch_body_too_large");
  });
  it("rate limits per proxy key with Retry-After", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st, { keyRate: [1, 3600] });
    expect((await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH))).status).toBe(200);
    const r2 = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r2.status).toBe(429);
    expect(await errType(r2)).toBe("mistwatch_rate_limited");
    expect(Number(r2.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("rate limits globally", async () => {
    const st = baseState(() => okJson());
    const p = createProxy(st, { globalRate: [1, 3600] });
    expect((await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH))).status).toBe(200);
    expect((await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH))).status).toBe(429);
  });
  it("overflows a full queue with 503", async () => {
    calls.length = 0;
    const [gate, release] = gated();
    const st = baseState(async () => {
      await gate;
      return okJson();
    });
    const p = createProxy(st, { concurrency: 1, maxPending: 1 });
    const r1 = p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    await waitFor(() => calls.length === 1);
    const r2 = p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    const r3 = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r3.status).toBe(503);
    expect(await errType(r3)).toBe("mistwatch_queue_full");
    release();
    expect((await r1).status).toBe(200);
    expect((await r2).status).toBe(200);
  });
  it("times out a request stuck in the queue", async () => {
    calls.length = 0;
    const [gate, release] = gated();
    const st = baseState(async () => {
      await gate;
      return okJson();
    });
    const p = createProxy(st, { concurrency: 1, maxPending: 8, totalTimeoutS: 0.05 });
    const r1 = p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    await waitFor(() => calls.length === 1);
    const r2 = await p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    expect(r2.status).toBe(503);
    expect(await errType(r2)).toBe("mistwatch_queue_timeout");
    release();
    await r1;
  });
  it("drain aborts stragglers and releases reservations", async () => {
    calls.length = 0;
    const [gate, release] = gated();
    const st = baseState((_u, init) =>
      abortable(
        gate.then(() => okJson()),
        init?.signal,
      ),
    );
    const p = createProxy(st);
    const r1 = p.handle(jreq("/v1/chat/completions", { model: "m" }, AUTH));
    await waitFor(() => calls.length === 1);
    const d = p.drain(30);
    await waitFor(() => must(st.engine.status("a", "api")).inflight === 0);
    await d;
    release();
    const r = await r1;
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
describe("proxy accounting hardening", () => {
  it("runs the llm classifier through the queue and reserves its cost", async () => {
    calls.length = 0;
    let active = 0;
    let peak = 0;
    const cfg = mkCfg([acct()]);
    cfg.router.llm_classifier = true;
    const st = createState(
      cfg,
      fakeFetch(async (_u, init) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        const b = bodyOf(init);
        if (isRec(b) && b.model === cfg.router.classifier_model)
          return json({
            choices: [{ message: { content: '{"difficulty": 5}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          });
        return okJson();
      }),
    );
    seedPool(st, "a", "api", 0, 12.75);
    seedPool(st, "a", "vibe", 127.5, 127.5);
    const p = createProxy(st, { concurrency: 1, maxPending: 64 });
    const rs = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const r = await p.handle(
          jreq(
            "/v1/chat/completions",
            { model: "auto", messages: [{ role: "user", content: `please explain topic number ${i} in some detail` }] },
            AUTH,
          ),
        );
        await r.text();
        return r.status;
      }),
    );
    expect(rs.every((s) => s === 200)).toBe(true);
    expect(peak).toBe(1);
    expect(st.db.recent().some((r) => r.endpoint === "router")).toBe(true);
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
  });
  it("skips the classifier when the first account key cannot be resolved and forwards via the next account", async () => {
    calls.length = 0;
    delete process.env.MW_TEST_UNSET_KEY;
    const first = { ...acct("a", { vibe: "env:MW_TEST_UNSET_KEY", api: "env:MW_TEST_UNSET_KEY" }), priority: 1 };
    const cfg = mkCfg([first, acct("b", { vibe: "b-vibe", api: "b-api" })]);
    cfg.router.llm_classifier = true;
    const st = createState(
      cfg,
      fakeFetch(() => okJson()),
    );
    for (const name of ["a", "b"]) {
      seedPool(st, name, "api", 0, 12.75);
      seedPool(st, name, "vibe", 127.5, 127.5);
    }
    const r = await createProxy(st).handle(
      jreq(
        "/v1/chat/completions",
        { model: "auto", messages: [{ role: "user", content: "please explain this topic in some detail" }] },
        AUTH,
      ),
    );
    await r.text();
    expect(r.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toMatch(/^Bearer b-/);
  });
  it("aborts the classifier fetch on client abort and holds the reservation until it ends", async () => {
    calls.length = 0;
    const cfg = mkCfg([acct()]);
    cfg.router.llm_classifier = true;
    const [gate, release] = gated();
    let sig: AbortSignal | null | undefined;
    const st = createState(
      cfg,
      fakeFetch(async (_u, init) => {
        sig = init?.signal;
        await gate;
        return json({
          choices: [{ message: { content: '{"difficulty": 5}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        });
      }),
    );
    seedPool(st, "a", "api", 0, 12.75);
    seedPool(st, "a", "vibe", 127.5, 127.5);
    const ctrl = new AbortController();
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "describe the abort handling of queued classifier work" }],
    };
    const r = createProxy(st).handle(
      req("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      }),
    );
    r.catch(() => undefined);
    await waitFor(() => calls.length === 1);
    expect(must(st.engine.status("a", "api")).inflight).toBeGreaterThan(0);
    ctrl.abort();
    await waitFor(() => sig?.aborted === true);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(must(st.engine.status("a", "api")).inflight).toBeGreaterThan(0);
    release();
    await waitFor(() => must(st.engine.status("a", "api")).inflight === 0);
    expect(st.db.recent().some((x) => x.endpoint === "router")).toBe(true);
  });
  it("books an estimate when a 2xx body breaks mid-read", async () => {
    const st = baseState(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode("{"));
              c.error(new Error("reset"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const r = await createProxy(st).handle(
      jreq("/v1/chat/completions", { model: "mistral-large-4-0", max_tokens: 100 }, AUTH),
    );
    expect(r.status).toBe(502);
    const row = must(st.db.recent()[0]);
    expect(row.estimated).toBe(1);
    expect(row.completion_tokens).toBe(100);
    expect(must(st.engine.status("a", "api")).inflight).toBe(0);
  });
  it("lets a non-streaming upstream take longer than the connect limit to answer", async () => {
    const st = baseState(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return okJson();
    });
    const r = await createProxy(st, { connectTimeoutS: 0.05 }).handle(
      jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, AUTH),
    );
    expect(r.status).toBe(200);
  });
  it("survives a negative max_tokens", async () => {
    const st = baseState(() => okJson());
    const r = await createProxy(st).handle(
      jreq("/v1/chat/completions", { model: "mistral-large-4-0", max_tokens: -1e9 }, AUTH),
    );
    expect(r.status).toBe(200);
  });
  it("adds Retry-After to a passed-through upstream 429", async () => {
    const st = baseState(() => json({ error: "slow down" }, 429));
    const r = await createProxy(st).handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, AUTH));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("Retry-After follows a temporary block, not an unrelated month reset", async () => {
    const st = baseState(() => okJson());
    st.blockedUntil.set(blockKey("a", "api"), Date.now() / 1000 + 30);
    st.cfg.limits.fallback_to_other_pool = false;
    const r = await createProxy(st).handle(jreq("/v1/chat/completions", { model: "mistral-large-4-0" }, AUTH));
    expect(r.status).toBe(429);
    const ra = Number(r.headers.get("retry-after"));
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(30);
  });
  it("labels a pool that has room but not enough for the request", () => {
    const st = baseState(() => okJson());
    const info = exhaustedInfo(st, Date.now() / 1000, "api");
    expect(info.pools.find((x) => x.pool === "api")?.blocked_by).toBe("insufficient-room");
  });
  it("counts tool call chunks and code points in the stream fallback", async () => {
    const e = "😀".repeat(8);
    const chunk = (delta: unknown): string => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    const st = baseState(
      () =>
        new Response(
          chunk({ content: e }) +
            chunk({ tool_calls: [{ function: { name: "abcd", arguments: e } }] }) +
            "data: [DONE]\n\n",
        ),
    );
    const r = await createProxy(st).handle(
      jreq("/v1/chat/completions", { model: "mistral-large-4-0", stream: true }, AUTH),
    );
    await r.text();
    expect(must(st.db.recent()[0]).completion_tokens).toBe(5);
  });
});
