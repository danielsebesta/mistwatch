import { randomBytes } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as v from "valibot";
import type { AccountView, Pool, StatusResponse } from "../shared/api.ts";
import { type Adopted, adoptAccount, adoptKey } from "./adopt.ts";
import { render, TOOL_ORDER } from "./agents.ts";
import { poolStatusDict } from "./budget.ts";
import { keyFor } from "./config.ts";
import { type AppException, apiErrorBody, appError, asException, errorHeaders, errors, isAppError } from "./errors.ts";
import { summarize } from "./groups.ts";
import { fetchOwner } from "./owner.ts";
import { createLoginLockout, createRateLimiter, type RateLimiter } from "./ratelimit.ts";
import { truthy } from "./router.ts";
import { bodyWithinLimit, clientIp, isHttps, localRequestAllowed, readLimitedBody } from "./security.ts";
import { SignInError } from "./signin.ts";
import { blockKey, reloadAccounts, type State } from "./state.ts";
import { SESSION_TTL, StoreError, VIBE_REF, vibeCliKeyPresent } from "./store.ts";
import { checkKey, syncAll } from "./sync.ts";
import type { Account, SessionUser } from "./types.ts";
import { DIMENSIONS, RANGES, usage } from "./usage.ts";
export const COOKIE = "mw_session";
const BODY_LIMIT = 256 * 1024;
export type WebApiOpts = { apiLimit?: RateLimiter; upstreamLimit?: RateLimiter; loginLimit?: RateLimiter };
const JsonObject = v.custom<Record<string, unknown>>(
  (x) => typeof x === "object" && x !== null && !Array.isArray(x),
  "Request body must be a JSON object.",
);
const apiError = (status: number, message: string): AppException =>
  asException(appError("mistwatch_http", status, message));
const errResponse = (status: number, message: string, retryAfter?: number): Response => {
  const e = appError("mistwatch_http", status, message, retryAfter === undefined ? {} : { retryAfter });
  return new Response(JSON.stringify(apiErrorBody(e)), {
    status: e.status,
    headers: { "content-type": "application/json", ...errorHeaders(e) },
  });
};
const strOf = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" || typeof v === "boolean" ? String(v) : "";
const intOf = (v: unknown): number | null => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  return null;
};
const boolOf = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  const i = intOf(v);
  return i === null ? null : i !== 0;
};
const truthyQuery = (v: string | undefined): boolean =>
  v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());
const isPool = (s: string): s is Pool => s === "vibe" || s === "api";
// Count code points, not UTF-16 units.
const clip = (s: string): string => Array.from(s).slice(0, 256).join("");
const statusPayload = (st: State, now: number): StatusResponse => {
  const pools: StatusResponse["pools"] = [];
  const enabledByName = new Map(st.cfg.accounts.map((a) => [a.name, a.enabled]));
  for (const a of st.cfg.accounts) {
    for (const pool of ["vibe", "api"] as const) {
      const s = st.engine.status(a.name, pool, now);
      if (!s) continue;
      const row = poolStatusDict(s);
      pools.push({
        ...row,
        pool,
        blocked_temporarily: (st.blockedUntil.get(blockKey(a.name, pool)) ?? 0) > now,
        enabled: [a.name, ...row.members].some((m) => enabledByName.get(m) === true),
      });
    }
  }
  return {
    now,
    last_sync: st.lastSync,
    pools,
    summary: summarize(st.engine, st.cfg.accounts, now),
    by_client_7d: st.db.byClientSince(now - 7 * 86400).flatMap((r) => (isPool(r.pool) ? [{ ...r, pool: r.pool }] : [])),
  };
};
export const createWebApi = (st: State, opts: WebApiOpts = {}): Hono => {
  const api = new Hono();
  const apiLimit = opts.apiLimit ?? createRateLimiter({ limit: 240, windowS: 60 });
  const upstreamLimit = opts.upstreamLimit ?? createRateLimiter({ limit: 12, windowS: 60 });
  const loginLimit = opts.loginLimit ?? createRateLimiter({ limit: 20, windowS: 60 });
  const lockout = createLoginLockout({ maxFails: 5, lockS: 60, windowS: 600, maxKeys: 8192 });
  const addr = (c: Context): string => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      remote = undefined;
    }
    return clientIp(remote, c.req.header("x-forwarded-for"), st.cfg.trust_proxy);
  };
  const csrf = (c: Context): void => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-mw") !== "1")
      throw apiError(403, "Missing x-mw header (CSRF protection).");
  };
  const requireUser = (c: Context): SessionUser => {
    const u = st.store.getSession(getCookie(c, COOKIE));
    if (!u) throw apiError(401, "You are not signed in.");
    csrf(c);
    return u;
  };
  const limitUpstream = (c: Context): void => {
    const r = upstreamLimit.check(addr(c));
    if (!r.allowed) throw asException(errors.rateLimited(r.retryAfter));
  };
  const lock = (u: SessionUser, c: Context): void => {
    const left = lockout.check(u.username, addr(c));
    if (left > 0) throw asException(errors.locked(left));
  };
  const jsonBody = async (c: Context): Promise<Record<string, unknown>> => {
    if (!bodyWithinLimit(c.req.header("content-length"), BODY_LIMIT)) throw asException(errors.tooLarge());
    const raw = await readLimitedBody(c.req.raw.body, BODY_LIMIT);
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw apiError(400, "Request body must be a JSON object.");
    }
    const p = v.safeParse(JsonObject, data);
    if (!p.success) throw apiError(400, p.issues[0]?.message ?? "Request body must be a JSON object.");
    return p.output;
  };
  const setSessionCookie = (c: Context, token: string): void => {
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_TTL,
      secure: isHttps(new URL(c.req.url).protocol, c.req.header("x-forwarded-proto"), st.cfg.trust_proxy),
    });
  };
  api.use("*", async (c, next) => {
    if (
      !localRequestAllowed(
        { host: c.req.header("host"), origin: c.req.header("origin") },
        { port: st.cfg.port, extraHosts: st.cfg.allowed_hosts },
      )
    )
      throw asException(errors.forbiddenHost(st.cfg.port));
    const r = apiLimit.check(addr(c));
    if (!r.allowed) throw asException(errors.rateLimited(r.retryAfter));
    await next();
  });
  api.onError((e) => {
    if (e instanceof StoreError) return errResponse(400, e.message);
    if (isAppError(e)) return errResponse(e.status, e.message, e.retryAfter);
    console.error("webapi: unhandled error:", e);
    return errResponse(500, "Internal server error.");
  });
  // ---------- session ----------
  api.get("/session", (c) => {
    const u = st.store.getSession(getCookie(c, COOKIE));
    return c.json({ setup_needed: st.store.countUsers() === 0, user: u });
  });
  let setupChain: Promise<unknown> = Promise.resolve();
  const setup = async (c: Context): Promise<Response> => {
    if (st.store.countUsers() > 0) throw apiError(409, "An account already exists, please sign in.");
    const b = await jsonBody(c);
    const uid = await st.store.createUserAsync(strOf(b.username), strOf(b.password));
    setSessionCookie(c, st.store.createSession(uid));
    const out: { ok: true; api_key?: { name: string; secret: string } } = { ok: true };
    if (!st.store.hasApiKeys()) {
      // a fresh install should not leave the proxy open to every local process
      const [row, secret] = st.store.createApiKey("default");
      out.api_key = { name: row.name, secret };
    }
    return c.json(out);
  };
  api.post("/setup", (c) => {
    csrf(c);
    // serialised so concurrent first-run requests cannot both pass the empty-users check
    const run = setupChain.then(() => setup(c));
    setupChain = run.catch(() => undefined);
    return run;
  });
  api.post("/login", async (c) => {
    csrf(c);
    const b = await jsonBody(c);
    const name = strOf(b.username).trim();
    const a = addr(c);
    const rl = loginLimit.check(a);
    if (!rl.allowed) throw asException(errors.rateLimited(rl.retryAfter));
    const left = lockout.check(name, a);
    if (left > 0) throw asException(errors.locked(left));
    const u = await st.store.verifyLoginAsync(name, clip(strOf(b.password)));
    if (!u) {
      lockout.fail(name, a);
      throw apiError(401, "Wrong username or password.");
    }
    lockout.success(name, a);
    setSessionCookie(c, st.store.createSession(u.id));
    return c.json({ ok: true, user: u });
  });
  api.post("/logout", (c) => {
    csrf(c);
    st.store.deleteSession(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  api.post("/password", async (c) => {
    const u = requireUser(c);
    lock(u, c);
    const b = await jsonBody(c);
    if (!(await st.store.checkUserPasswordAsync(u.id, clip(strOf(b.old))))) {
      lockout.fail(u.username, addr(c));
      throw apiError(400, "Current password is incorrect.");
    }
    lockout.success(u.username, addr(c));
    await st.store.setPasswordAsync(u.id, strOf(b.new));
    st.store.deleteOtherSessions(u.id, getCookie(c, COOKIE));
    return c.json({ ok: true });
  });
  // ---------- users ----------
  api.get("/users", (c) => {
    requireUser(c);
    return c.json(st.store.listUsers());
  });
  api.post("/users", async (c) => {
    requireUser(c);
    const b = await jsonBody(c);
    await st.store.createUserAsync(strOf(b.username), strOf(b.password));
    return c.json({ ok: true });
  });
  api.delete("/users/:id", (c) => {
    const u = requireUser(c);
    const id = intOf(c.req.param("id"));
    if (id === null) throw apiError(400, "Invalid user id.");
    if (id === u.id) throw apiError(400, "You cannot delete yourself.");
    st.store.deleteUser(id);
    return c.json({ ok: true });
  });
  // ---------- dashboard ----------
  api.get("/status", (c) => {
    requireUser(c);
    return c.json(statusPayload(st, Date.now() / 1000));
  });
  api.get("/summary", (c) => {
    requireUser(c);
    return c.json({ last_sync: st.lastSync, ...summarize(st.engine, st.cfg.accounts) });
  });
  api.get("/usage", (c) => {
    requireUser(c);
    const range = c.req.query("range") ?? "7d";
    const by = c.req.query("by") ?? "model";
    if (!Object.hasOwn(RANGES, range) || !DIMENSIONS.includes(by)) throw apiError(400, "Unknown range or grouping.");
    return c.json(usage(st.db, range, by, Date.now() / 1000, st.names));
  });
  api.get("/ledger", (c) => {
    requireUser(c);
    const limit = intOf(c.req.query("limit") ?? "40");
    if (limit === null) throw apiError(400, "Invalid limit.");
    const rows = st.db.recent(Math.max(1, Math.min(limit, 500)));
    return c.json(rows.map((r) => ({ ...r, model_name: r.model ? st.names.display(r.model) : null })));
  });
  // ---------- model names ----------
  api.get("/models", (c) => {
    requireUser(c);
    return c.json(st.names.listing(truthyQuery(c.req.query("all"))));
  });
  api.put("/models/:key{.+}", async (c) => {
    requireUser(c);
    const b = await jsonBody(c);
    try {
      st.names.setOverride(c.req.param("key"), strOf(b.display));
    } catch (e) {
      throw apiError(400, e instanceof Error ? e.message : String(e));
    }
    return c.json({ ok: true });
  });
  api.delete("/models/:key{.+}", (c) => {
    requireUser(c);
    st.names.clearOverride(c.req.param("key"));
    return c.json({ ok: true });
  });
  api.post("/models-refresh", async (c) => {
    requireUser(c);
    limitUpstream(c);
    for (const a of st.cfg.accounts) {
      for (const pool of Object.keys(a.keys)) {
        try {
          const models = await st.names.refresh(st.fetch, st.cfg.upstream, keyFor(a, pool) ?? "");
          return c.json({ models });
        } catch {}
      }
    }
    throw apiError(502, "Could not load the model list from Mistral (is a key configured?).");
  });
  api.post("/sync", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const res = await syncAll(st.fetch, st.cfg, st.db);
    st.lastSync = Date.now() / 1000;
    st.blockedUntil.clear();
    return c.json(res);
  });
  // ---------- Mistral accounts and keys ----------
  const acctView = (a: Account): AccountView => {
    const ki = st.store.keyInfo(a);
    return {
      name: a.name,
      priority: a.priority,
      enabled: a.enabled,
      keys: { vibe: ki.vibe ?? null, api: ki.api ?? null },
      shared_with: st.db.members(a.name).filter((m) => m !== a.name),
    };
  };
  const getAcct = (name: string): Account => {
    const a = st.store.getAccount(name);
    if (!a) throw apiError(404, "Account does not exist.");
    return a;
  };
  api.get("/accounts", (c) => {
    requireUser(c);
    return c.json({ accounts: st.store.listAccounts().map(acctView), vibe_cli_available: vibeCliKeyPresent() });
  });
  api.get("/accounts/:name/owner", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const a = getAcct(c.req.param("name"));
    const [vibe, studio] = await Promise.all(
      (["vibe", "api"] as const).map(async (pool) => {
        const key = keyFor(a, pool);
        return key ? await fetchOwner(st.fetch, st.cfg.upstream, st.cfg.console_upstream, key, pool === "vibe") : null;
      }),
    );
    return c.json({ vibe: vibe ?? null, api: studio ?? null });
  });
  // Accounts are never created by hand: a key or a Mistral sign-in is placed under its owner (see adopt.ts).
  const finishAdopt = async (c: Context, moved: Adopted[]) => {
    reloadAccounts(st);
    st.blockedUntil.clear();
    await syncAll(st.fetch, st.cfg, st.db);
    st.lastSync = Date.now() / 1000;
    return c.json({ ok: true, adopted: moved });
  };
  api.post("/keys/add", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const b = await jsonBody(c);
    let secret: { value: string } | { ref: string };
    if (b.source === "vibe-cli") {
      if (!vibeCliKeyPresent()) throw apiError(400, "No Vibe CLI sign-in in the keyring (run `vibe --setup`).");
      secret = { ref: VIBE_REF };
    } else {
      const key = strOf(b.key).trim();
      if (!key) throw apiError(400, "Key is missing.");
      secret = { value: key };
    }
    return finishAdopt(c, [await adoptKey(st, secret)]);
  });
  api.post("/accounts/:name/adopt", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const name = c.req.param("name");
    getAcct(name);
    return finishAdopt(c, await adoptAccount(st, name));
  });
  api.post("/signin", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const temp = `pending-${randomBytes(4).toString("hex")}`;
    st.store.createAccount(temp);
    reloadAccounts(st);
    try {
      return c.json(await st.signin.start(temp, "vibe"));
    } catch (e) {
      st.store.deleteAccount(temp);
      reloadAccounts(st);
      if (e instanceof SignInError) throw apiError(400, e.message);
      throw e;
    }
  });
  api.patch("/accounts/:name", async (c) => {
    requireUser(c);
    const name = c.req.param("name");
    getAcct(name);
    const b = await jsonBody(c);
    const enabled = b.enabled === undefined || b.enabled === null ? undefined : boolOf(b.enabled);
    const priority = b.priority === undefined || b.priority === null ? undefined : intOf(b.priority);
    if (enabled === null || priority === null) throw apiError(400, "Invalid enabled or priority value.");
    st.store.updateAccount(name, enabled, priority);
    reloadAccounts(st);
    return c.json({ ok: true });
  });
  api.delete("/accounts/:name", (c) => {
    requireUser(c);
    const name = c.req.param("name");
    getAcct(name);
    st.store.deleteAccount(name);
    reloadAccounts(st);
    return c.json({ ok: true });
  });
  api.post("/keys/check", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const b = await jsonBody(c);
    const key = strOf(b.key).trim();
    if (!key) throw apiError(400, "Key is missing.");
    return c.json(await checkKey(st.fetch, st.cfg.upstream, key));
  });
  api.put("/accounts/:name/keys/:pool", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const name = c.req.param("name");
    const pool = c.req.param("pool");
    getAcct(name);
    const b = await jsonBody(c);
    if (b.source === "vibe-cli") {
      if (!vibeCliKeyPresent()) throw apiError(400, "No Vibe CLI sign-in in the keyring (run `vibe --setup`).");
      st.store.setKey(name, pool, { ref: VIBE_REF });
    } else {
      const key = strOf(b.key).trim();
      if (truthy(b.verify ?? true)) {
        const chk = await checkKey(st.fetch, st.cfg.upstream, key);
        if (!chk.valid) throw apiError(400, chk.error ?? "Mistral rejected the key.");
      }
      st.store.setKey(name, pool, { value: key });
    }
    reloadAccounts(st);
    st.blockedUntil.clear();
    const a = getAcct(name);
    // full sync pass: also re-detects shared budgets
    const synced = (await syncAll(st.fetch, st.cfg, st.db))[name] ?? {};
    st.lastSync = Date.now() / 1000;
    return c.json({ ok: true, synced, account: acctView(a) });
  });
  api.delete("/accounts/:name/keys/:pool", (c) => {
    requireUser(c);
    const name = c.req.param("name");
    getAcct(name);
    st.store.removeKey(name, c.req.param("pool"));
    reloadAccounts(st);
    return c.json({ ok: true });
  });
  // ---------- sign in through Mistral (browser flow, like `vibe --setup`) ----------
  api.post("/accounts/:name/signin", async (c) => {
    requireUser(c);
    limitUpstream(c);
    const name = c.req.param("name");
    getAcct(name);
    try {
      return c.json(await st.signin.start(name, "vibe"));
    } catch (e) {
      if (e instanceof SignInError) throw apiError(400, e.message);
      throw e;
    }
  });
  api.get("/signin/:id", (c) => {
    requireUser(c);
    const a = st.signin.get(c.req.param("id"));
    if (!a) throw apiError(404, "Sign-in attempt does not exist.");
    return c.json(a);
  });
  api.delete("/signin/:id", (c) => {
    requireUser(c);
    if (!st.signin.cancel(c.req.param("id"))) throw apiError(404, "Sign-in attempt does not exist.");
    return c.json({ ok: true });
  });
  // ---------- tool configs ----------
  api.get("/agent-config", (c) => {
    requireUser(c);
    const base = new URL(c.req.url).origin;
    return c.json(TOOL_ORDER.map((t) => render(t, base)));
  });
  // ---------- proxy API keys ----------
  api.get("/apikeys", (c) => {
    requireUser(c);
    return c.json({ keys: st.store.listApiKeys(), base_url: `${new URL(c.req.url).origin}/v1` });
  });
  api.post("/apikeys", async (c) => {
    requireUser(c);
    const b = await jsonBody(c);
    const [row, secret] = st.store.createApiKey(strOf(b.name));
    return c.json({ key: row, secret });
  });
  api.delete("/apikeys/:id", (c) => {
    requireUser(c);
    const id = intOf(c.req.param("id"));
    if (id === null) throw apiError(400, "Invalid key id.");
    if (!st.store.deleteApiKey(id)) throw apiError(404, "Key does not exist.");
    return c.json({ ok: true });
  });
  api.all("/*", () => errResponse(404, "Not Found"));
  return api;
};
