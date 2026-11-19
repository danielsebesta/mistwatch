import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { defaultConfig } from "../src/config.ts";
import { createRateLimiter } from "../src/ratelimit.ts";
import { createState, reloadAccounts } from "../src/state.ts";
import { hashPassword, verifyPassword } from "../src/store.ts";
import type { FetchLike } from "../src/types.ts";
import type { WebApiOpts } from "../src/webapi.ts";
import { must } from "./helpers.ts";

process.env.MISTWATCH_NO_KEYRING = "1";

const BASE = "http://localhost:8787";
const H = { "x-mw": "1" };
const PW = "correct horse battery";
const WEB_DIR = fileURLToPath(new URL("../dist/web", import.meta.url));
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const upstream: Handler = (url, init) => {
  const key = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const p = new URL(url).pathname;
  if (p === "/v1/billing/budget") {
    if (key.startsWith("bad")) return json({ message: "no" }, 401);
    return json({
      vibe_budget: { usage_percentage: 10, initial_budget: 100, reset_at: "2099-01-01T00:00:00Z", currency: "EUR" },
      api_budget: { usage_percentage: 50, initial_budget: 10, reset_at: "2099-01-01T00:00:00Z", currency: "EUR" },
    });
  }
  if (p === "/v1/models")
    return key.startsWith("bad") ? new Response(null, { status: 401 }) : json({ data: [{ id: "m1" }] });
  return json({ model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
};
type App = { app: Hono; st: ReturnType<typeof createState> };
const mkApp = (apiOpts: WebApiOpts = {}, fetchFn: FetchLike = upstream as FetchLike): App => {
  const cfg = defaultConfig();
  cfg.db_path = ":memory:";
  const st = createState(cfg, fetchFn);
  return { st, app: createApp(st, { webDir: WEB_DIR, apiOpts }) };
};
const api = async (app: Hono, path: string, init: RequestInit = {}): Promise<Response> => {
  const h = new Headers(init.headers);
  if (!h.has("host")) h.set("host", "localhost:8787");
  return app.request(`${BASE}${path}`, { ...init, headers: h });
};
const jpost = (app: Hono, path: string, body: unknown, h: Record<string, string> = {}): Promise<Response> =>
  api(app, path, {
    method: "POST",
    headers: { "content-type": "application/json", ...h },
    body: JSON.stringify(body),
  });
const jbody = (app: Hono, method: string, path: string, body: unknown, h: Record<string, string>): Promise<Response> =>
  api(app, path, {
    method,
    headers: { "content-type": "application/json", ...h },
    body: JSON.stringify(body),
  });
const cookieOf = (r: Response): string => r.headers.getSetCookie()[0]?.split(";")[0] ?? "";
const login = async (app: Hono): Promise<{ cookie: string; out: Record<string, unknown> }> => {
  const r = await jpost(app, "/api/setup", { username: "daniel", password: PW }, H);
  const out: unknown = JSON.parse(await r.text());
  if (r.status !== 200 || !isRec(out)) throw new Error(`setup failed: ${JSON.stringify(out)}`);
  return { cookie: cookieOf(r), out };
};
const authed = (cookie: string): Record<string, string> => ({ ...H, cookie });

describe("web ui and session gate", () => {
  it("serves the UI, reports setup state and gates /api", async () => {
    const { app } = mkApp();
    const index = await api(app, "/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("Mistwatch");
    const sess = await api(app, "/api/session");
    expect(await sess.json()).toEqual({ setup_needed: true, user: null });
    expect((await api(app, "/api/status")).status).toBe(401);
  });
  it("issues an HttpOnly SameSite=Strict session cookie", async () => {
    const { app } = mkApp();
    const r = await jpost(app, "/api/setup", { username: "daniel", password: PW }, H);
    const c = r.headers.getSetCookie()[0] ?? "";
    expect(c).toContain("mw_session=");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=2592000");
    expect(c).not.toContain("Secure");
  });
  it("allows inline scripts by hash instead of unsafe-inline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mw-web-"));
    const body = "console.log(1)";
    writeFileSync(join(dir, "index.html"), `<html><script type="module">${body}</script></html>`);
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    const app = createApp(createState(cfg, upstream as FetchLike), { webDir: dir });
    const csp = (await api(app, "/")).headers.get("content-security-policy") ?? "";
    const hash = createHash("sha256").update(body).digest("base64");
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}';`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    rmSync(dir, { recursive: true, force: true });
  });
  it("serves llms.txt publicly", async () => {
    const { app } = mkApp();
    const r = await api(app, "/llms.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const t = await r.text();
    expect(t).toContain("/v1/chat/completions");
    expect(t).toContain("mistwatch_budget_exhausted");
  });
  it("returns 404 JSON for unknown /api paths", async () => {
    const { app } = mkApp();
    const r = await api(app, "/api/definitely-not-a-route");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ detail: "Not Found" });
    const bare = await api(app, "/api");
    expect(bare.status).toBe(404);
    expect(await bare.json()).toEqual({ detail: "Not Found" });
  });
  it("serves the brand assets with the right content types", async () => {
    const { app } = mkApp();
    const kinds: [string, string][] = [
      ["/favicon.svg", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/icon-192.png", "image/png"],
      ["/icon-512.png", "image/png"],
      ["/logo.svg", "image/svg+xml"],
      ["/logo-dark.svg", "image/svg+xml"],
      ["/mark.svg", "image/svg+xml"],
      ["/site.webmanifest", "application/manifest+json"],
    ];
    for (const [path, kind] of kinds) {
      const r = await api(app, path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type"), path).toContain(kind);
      expect((await r.arrayBuffer()).byteLength, path).toBeGreaterThan(0);
    }
    expect(await (await api(app, "/")).text()).toContain("not affiliated with");
  });
});

describe("security guards", () => {
  it("rejects foreign Host headers on api and ui routes", async () => {
    const { app } = mkApp();
    const a = await api(app, "/api/session", { headers: { host: "evil.example.com" } });
    expect(a.status).toBe(403);
    expect(await a.json()).toEqual({ detail: expect.stringContaining("This address is not allowed") });
    const u = await api(app, "/", { headers: { host: "evil.example.com:8787" } });
    expect(u.status).toBe(403);
    const b: unknown = await u.json();
    expect(isRec(b) && isRec(b.error) ? b.error.type : null).toBe("mistwatch_forbidden");
    const badPort = await api(app, "/api/session", { headers: { host: "localhost:9999" } });
    expect(badPort.status).toBe(403);
  });
  it("rejects foreign Origin headers", async () => {
    const { app } = mkApp();
    const r = await api(app, "/api/session", { headers: { origin: "https://evil.example.com" } });
    expect(r.status).toBe(403);
    expect((await api(app, "/api/session", { headers: { origin: "null" } })).status).toBe(403);
    expect((await api(app, "/api/session", { headers: { origin: BASE } })).status).toBe(200);
  });
  it("rate limits /api per client address", async () => {
    const { app } = mkApp({ apiLimit: createRateLimiter({ limit: 2, windowS: 60 }) });
    expect((await api(app, "/api/session")).status).toBe(200);
    expect((await api(app, "/api/session")).status).toBe(200);
    const r = await api(app, "/api/session");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await r.json()).toEqual({ detail: expect.stringContaining("Too many requests") });
  });
  it("rate limits upstream-bound operations", async () => {
    const { app } = mkApp({ upstreamLimit: createRateLimiter({ limit: 1, windowS: 3600 }) });
    const { cookie } = await login(app);
    expect((await jpost(app, "/api/sync", {}, authed(cookie))).status).toBe(200);
    const r = await jpost(app, "/api/sync", {}, authed(cookie));
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ detail: expect.stringContaining("Too many requests") });
  });
  it("returns 400 for malformed or non-object JSON bodies", async () => {
    const { app } = mkApp();
    const bad = await api(app, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...H },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    const arr = await jpost(app, "/api/setup", [1, 2, 3], H);
    expect(arr.status).toBe(400);
    const { cookie } = await login(app);
    expect((await jpost(app, "/api/keys/add", 42, authed(cookie))).status).toBe(400);
  });
  it("returns 400 for invalid ids and parameters", async () => {
    const { app } = mkApp();
    const { cookie } = await login(app);
    expect((await api(app, "/api/users/abc", { method: "DELETE", headers: authed(cookie) })).status).toBe(400);
    expect((await api(app, "/api/apikeys/abc", { method: "DELETE", headers: authed(cookie) })).status).toBe(400);
    expect((await api(app, "/api/usage?range=bogus", { headers: authed(cookie) })).status).toBe(400);
    expect((await api(app, "/api/usage?by=bogus", { headers: authed(cookie) })).status).toBe(400);
    for (const range of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect((await api(app, `/api/usage?range=${range}`, { headers: authed(cookie) })).status).toBe(400);
    expect((await api(app, "/api/ledger?limit=abc", { headers: authed(cookie) })).status).toBe(400);
    expect((await api(app, "/api/signin/nope", { headers: authed(cookie) })).status).toBe(404);
    expect((await api(app, "/api/signin/nope", { method: "DELETE", headers: authed(cookie) })).status).toBe(404);
  });
});

describe("sessions, setup and login", () => {
  it("hashes passwords with a salted scrypt format", () => {
    const h = hashPassword("secret-password");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("secret-password");
    expect(verifyPassword("secret-password", h)).toBe(true);
    expect(verifyPassword("nope", h)).toBe(false);
    expect(hashPassword("secret-password")).not.toBe(h);
  });
  it("lets only one of several concurrent setups succeed", async () => {
    const { app, st } = mkApp();
    const rs = await Promise.all(
      ["u1", "u2", "u3"].map((username) => jpost(app, "/api/setup", { username, password: PW }, H)),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(st.store.countUsers()).toBe(1);
  });
  it("counts password length in code points for setup, login and password change", async () => {
    const { app } = mkApp();
    const long = "😀".repeat(130);
    const setup = await jpost(app, "/api/setup", { username: "daniel", password: long }, H);
    expect(setup.status).toBe(200);
    const ok = await jpost(app, "/api/login", { username: "daniel", password: long }, H);
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const next = "🎉".repeat(130);
    const ch = await jpost(app, "/api/password", { old: long, new: next }, { ...H, cookie });
    expect(ch.status).toBe(200);
    expect((await jpost(app, "/api/login", { username: "daniel", password: next }, H)).status).toBe(200);
  });
  it("sets up the first user, mints a default key and handles login/logout", async () => {
    const { app } = mkApp();
    const { cookie, out } = await login(app);
    const key = isRec(out.api_key) ? out.api_key : {};
    expect(typeof key.secret === "string" && key.secret.startsWith("mw-")).toBe(true);
    expect((await jpost(app, "/api/setup", { username: "x1", password: PW }, H)).status).toBe(409);
    const sess = await api(app, "/api/session", { headers: { cookie } });
    const sj: unknown = await sess.json();
    expect(isRec(sj) && isRec(sj.user) ? sj.user.username : null).toBe("daniel");
    await jpost(app, "/api/logout", {}, authed(cookie));
    expect((await api(app, "/api/status", { headers: { cookie } })).status).toBe(401);
    expect((await jpost(app, "/api/login", { username: "daniel", password: "wrong-password" }, H)).status).toBe(401);
    const r = await jpost(app, "/api/login", { username: "daniel", password: PW }, H);
    expect(r.status).toBe(200);
    expect((await api(app, "/api/status", { headers: { cookie: cookieOf(r) } })).status).toBe(200);
  });
  it("requires the x-mw header on non-GET requests", async () => {
    const { app } = mkApp();
    const { cookie } = await login(app);
    expect((await jpost(app, "/api/setup", { username: "x", password: PW })).status).toBe(403);
    expect((await jpost(app, "/api/keys/add", { key: "good-key-123456" }, { cookie })).status).toBe(403);
  });
  it("rejects weak passwords with 400", async () => {
    const { app } = mkApp();
    const r = await jpost(app, "/api/setup", { username: "daniel", password: "short" }, H);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ detail: "Password must be at least 10 characters." });
  });
  it("locks out repeated login failures", async () => {
    const { app } = mkApp();
    await login(app);
    await jpost(app, "/api/logout", {}, H);
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1)
      codes.push((await jpost(app, "/api/login", { username: "daniel", password: "bad-password-x" }, H)).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
    const r = await jpost(app, "/api/login", { username: "daniel", password: PW }, H);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("applies the lockout to padded usernames", async () => {
    const { app } = mkApp();
    await login(app);
    await jpost(app, "/api/logout", {}, H);
    for (let i = 0; i < 5; i += 1)
      await jpost(app, "/api/login", { username: "daniel", password: "bad-password-x" }, H);
    const r = await jpost(app, "/api/login", { username: " daniel ", password: PW }, H);
    expect(r.status).toBe(429);
  });
  it("expires idle and absolute-expired sessions and touches last_seen", async () => {
    const { app, st } = mkApp();
    const { cookie } = await login(app);
    const now = Date.now() / 1000;
    st.db.stmt("UPDATE sessions SET last_seen=?").run(now - 120);
    expect((await api(app, "/api/status", { headers: { cookie } })).status).toBe(200);
    const seen = st.db.stmt("SELECT last_seen FROM sessions").get()?.last_seen;
    expect(typeof seen === "number" && Math.abs(seen - Date.now() / 1000) < 30).toBe(true);
    st.db.stmt("UPDATE sessions SET last_seen=?").run(now - 8 * 86400);
    expect((await api(app, "/api/status", { headers: { cookie } })).status).toBe(401);
    const c2 = cookieOf(await jpost(app, "/api/login", { username: "daniel", password: PW }, H));
    st.db.stmt("UPDATE sessions SET expires=?").run(1);
    expect((await api(app, "/api/status", { headers: { cookie: c2 } })).status).toBe(401);
  });
});

describe("users, accounts and keys", () => {
  it("manages users and blocks self-deletion", async () => {
    const { app } = mkApp();
    const { cookie } = await login(app);
    expect(
      (await jpost(app, "/api/users", { username: "anna", password: "another-long-pass" }, authed(cookie))).status,
    ).toBe(200);
    const users: unknown = await (await api(app, "/api/users", { headers: authed(cookie) })).json();
    const me = Array.isArray(users) ? users.find((u) => isRec(u) && u.username === "daniel") : undefined;
    const id = isRec(me) && typeof me.id === "number" ? me.id : -1;
    expect((await api(app, `/api/users/${id}`, { method: "DELETE", headers: authed(cookie) })).status).toBe(400);
    expect(
      (await jpost(app, "/api/password", { old: "wrong-old-pass", new: "brand-new-password" }, authed(cookie))).status,
    ).toBe(400);
    expect((await jpost(app, "/api/password", { old: PW, new: "brand-new-password" }, authed(cookie))).status).toBe(
      200,
    );
    await jpost(app, "/api/logout", {}, authed(cookie));
    expect((await jpost(app, "/api/login", { username: "daniel", password: PW }, H)).status).toBe(401);
    expect((await jpost(app, "/api/login", { username: "daniel", password: "brand-new-password" }, H)).status).toBe(
      200,
    );
  });
  it("deletes the other sessions on password change", async () => {
    const { app } = mkApp();
    const { cookie } = await login(app);
    const second = cookieOf(await jpost(app, "/api/login", { username: "daniel", password: PW }, H));
    expect((await api(app, "/api/status", { headers: { cookie: second } })).status).toBe(200);
    await jpost(app, "/api/password", { old: PW, new: "brand-new-password" }, authed(cookie));
    expect((await api(app, "/api/status", { headers: { cookie } })).status).toBe(200);
    expect((await api(app, "/api/status", { headers: { cookie: second } })).status).toBe(401);
  });
  it("stores keys after verification and syncs", async () => {
    const { app, st } = mkApp();
    const { cookie } = await login(app);
    st.store.createAccount("osobni");
    reloadAccounts(st);
    expect(
      (await jbody(app, "PUT", "/api/accounts/osobni/keys/api", { key: "bad-key-123456" }, authed(cookie))).status,
    ).toBe(400);
    const r = await jbody(app, "PUT", "/api/accounts/osobni/keys/api", { key: "good-key-123456" }, authed(cookie));
    expect(r.status).toBe(200);
    const put: unknown = await r.json();
    const synced = isRec(put) && isRec(put.synced) ? put.synced.api : null;
    expect(synced).toEqual({ used: 5, initial: 10, source: "mistral" });
    const accs: unknown = await (await api(app, "/api/accounts", { headers: authed(cookie) })).json();
    const acc = isRec(accs) && Array.isArray(accs.accounts) ? accs.accounts[0] : null;
    const keys = isRec(acc) && isRec(acc.keys) ? acc.keys : {};
    const apiKey = isRec(keys) && isRec(keys.api) ? keys.api : {};
    expect(isRec(apiKey) ? apiKey.hint : null).toBe("good-…3456");
    expect(isRec(keys) ? keys.vibe : "x").toBeNull();
    expect(JSON.stringify(accs)).not.toContain("good-key-123456");
    const status: unknown = await (await api(app, "/api/status", { headers: authed(cookie) })).json();
    const pools = new Set(
      isRec(status) && Array.isArray(status.pools)
        ? status.pools.map((p) => (isRec(p) ? `${p.account}/${p.pool}` : ""))
        : [],
    );
    expect(pools.has("osobni/api")).toBe(true);
    expect(
      (await api(app, "/api/accounts/osobni/keys/api", { method: "DELETE", headers: authed(cookie) })).status,
    ).toBe(200);
    expect((await api(app, "/api/accounts/osobni", { method: "DELETE", headers: authed(cookie) })).status).toBe(200);
  });
  it("marks a shared budget enabled while any member is enabled", async () => {
    const { app, st } = mkApp();
    const { cookie } = await login(app);
    for (const name of ["a", "b"]) {
      st.store.createAccount(name);
      reloadAccounts(st);
      await jbody(app, "PUT", `/api/accounts/${name}/keys/api`, { key: `good-key-${name}-123456` }, authed(cookie));
    }
    st.db.links.set("b", "a");
    await jbody(app, "PATCH", "/api/accounts/a", { enabled: false }, authed(cookie));
    const enabledOf = async (): Promise<unknown> => {
      const status: unknown = await (await api(app, "/api/status", { headers: authed(cookie) })).json();
      const pools = isRec(status) && Array.isArray(status.pools) ? status.pools : [];
      return pools.find((p) => isRec(p) && p.account === "a" && p.pool === "api");
    };
    expect(await enabledOf()).toMatchObject({ enabled: true });
    await jbody(app, "PATCH", "/api/accounts/b", { enabled: false }, authed(cookie));
    expect(await enabledOf()).toMatchObject({ enabled: false });
  });
  it("checks keys against Mistral without storing", async () => {
    const { app } = mkApp();
    const { cookie } = await login(app);
    const good: unknown = await (
      await jpost(app, "/api/keys/check", { key: "good-key-123456" }, authed(cookie))
    ).json();
    expect(isRec(good) ? good.valid : null).toBe(true);
    const bad: unknown = await (await jpost(app, "/api/keys/check", { key: "bad-key-123456" }, authed(cookie))).json();
    expect(isRec(bad) ? bad.valid : null).toBe(false);
    expect((await jpost(app, "/api/keys/check", { key: "  " }, authed(cookie))).status).toBe(400);
  });
  it("accepts e-mail style account names and url-encoded paths", async () => {
    const { app, st } = mkApp();
    const { cookie } = await login(app);
    const name = "daniel+mistral@example.cz";
    st.store.createAccount(name);
    reloadAccounts(st);
    const q = encodeURIComponent(name);
    const r = await jbody(app, "PUT", `/api/accounts/${q}/keys/api`, { key: "good-key-123456" }, authed(cookie));
    expect(r.status, await r.text()).toBe(200);
    const accs: unknown = await (await api(app, "/api/accounts", { headers: authed(cookie) })).json();
    const first = isRec(accs) && Array.isArray(accs.accounts) ? accs.accounts[0] : null;
    expect(isRec(first) ? first.name : null).toBe(name);
    expect((await jbody(app, "PATCH", `/api/accounts/${q}`, { enabled: false }, authed(cookie))).status).toBe(200);
    expect((await api(app, `/api/accounts/${q}`, { method: "DELETE", headers: authed(cookie) })).status).toBe(200);
  });
  it("rejects invalid account patches and missing accounts", async () => {
    const { app, st } = mkApp();
    const { cookie } = await login(app);
    st.store.createAccount("osobni");
    reloadAccounts(st);
    expect((await jbody(app, "PATCH", "/api/accounts/osobni", { priority: "high" }, authed(cookie))).status).toBe(400);
    expect((await jbody(app, "PATCH", "/api/accounts/missing", { enabled: true }, authed(cookie))).status).toBe(404);
    expect((await api(app, "/api/accounts/missing", { method: "DELETE", headers: authed(cookie) })).status).toBe(404);
    expect(
      (await api(app, "/api/accounts/missing/keys/api", { method: "DELETE", headers: authed(cookie) })).status,
    ).toBe(404);
  });
});

describe("models, agent-config and sign-in", () => {
  it("lists, renames, resets and refreshes model names", async () => {
    const { app, st } = mkApp();
    const { cookie } = await login(app);
    const list: unknown = await (await api(app, "/api/models", { headers: authed(cookie) })).json();
    expect(Array.isArray(list)).toBe(true);
    expect(
      (await jbody(app, "PUT", "/api/models/mistral-large-4-0", { display: "My Large" }, authed(cookie))).status,
    ).toBe(200);
    expect((await jbody(app, "PUT", "/api/models/m", { display: "   " }, authed(cookie))).status).toBe(400);
    expect(
      (await api(app, "/api/models/mistral-large-4-0", { method: "DELETE", headers: authed(cookie) })).status,
    ).toBe(200);
    const refresh = await jpost(app, "/api/models-refresh", {}, authed(cookie));
    expect(refresh.status).toBe(502);
    st.store.createAccount("osobni");
    reloadAccounts(st);
    await jbody(app, "PUT", "/api/accounts/osobni/keys/api", { key: "good-key-123456", verify: false }, authed(cookie));
    const r2 = await jpost(app, "/api/models-refresh", {}, authed(cookie));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ models: 1 });
  });
  it("serves agent configs for all four tools behind auth", async () => {
    const { app } = mkApp();
    expect((await api(app, "/api/agent-config")).status).toBe(401);
    const { cookie } = await login(app);
    const r = await api(app, "/api/agent-config", { headers: authed(cookie) });
    const out: unknown = await r.json();
    const tools = Array.isArray(out) ? out.map((t) => (isRec(t) ? t.tool : null)) : [];
    expect(tools).toEqual(["opencode", "pi", "vibe", "env"]);
    for (const t of Array.isArray(out) ? out : []) {
      expect(isRec(t) && typeof t.content === "string" ? t.content : "").toContain("/v1");
    }
    const first = Array.isArray(out) && isRec(out[0]) && typeof out[0].content === "string" ? out[0].content : "";
    expect(first).toContain("MISTWATCH_TOKEN");
  });
  it("surfaces sign-in failures and 404s", async () => {
    const { app, st } = mkApp();
    const { cookie } = await login(app);
    st.store.createAccount("osobni");
    reloadAccounts(st);
    const r = await jpost(app, "/api/accounts/osobni/signin", {}, authed(cookie));
    expect(r.status).toBe(400);
    const b: unknown = await r.json();
    expect(isRec(b) && typeof b.detail === "string").toBe(true);
  });
});

describe("proxy keys lifecycle", () => {
  it("builds the base url from the request origin", async () => {
    const { app } = mkApp();
    const { cookie } = await login(app);
    const r = await app.request("http://[::1]:8787/api/apikeys", {
      headers: { ...authed(cookie), host: "[::1]:8787" },
    });
    const body: unknown = await r.json();
    expect(isRec(body) ? body.base_url : null).toBe("http://[::1]:8787/v1");
  });
  it("gates the proxy on created api keys", async () => {
    const { app } = mkApp();
    const { cookie } = await login(app);
    const cc = (h: Record<string, string>): Promise<Response> => jpost(app, "/v1/chat/completions", { model: "x" }, h);
    expect((await cc({})).status).toBe(401);
    expect((await cc({ authorization: "Bearer nope" })).status).toBe(401);
    const created = await jpost(app, "/api/apikeys", { name: "vibe-cli" }, authed(cookie));
    const body: unknown = await created.json();
    const secret = isRec(body) && typeof body.secret === "string" ? body.secret : "";
    const listing: unknown = await (await api(app, "/api/apikeys", { headers: authed(cookie) })).json();
    const names = new Set(
      isRec(listing) && Array.isArray(listing.keys) ? listing.keys.map((k) => (isRec(k) ? k.name : null)) : [],
    );
    expect(names).toEqual(new Set(["default", "vibe-cli"]));
    expect(JSON.stringify(listing)).not.toContain(secret);
    const noBudget = await cc({ authorization: `Bearer ${secret}` });
    expect(noBudget.status).toBe(429);
    const kid = isRec(body) && isRec(body.key) ? body.key.id : null;
    expect((await api(app, `/api/apikeys/${kid}`, { method: "DELETE", headers: authed(cookie) })).status).toBe(200);
    expect((await cc({ authorization: `Bearer ${secret}` })).status).toBe(401);
  });
  it("forwards a chat completion through the whole stack and books it", async () => {
    const { app, st } = mkApp();
    const { cookie, out } = await login(app);
    const key = isRec(out.api_key) && typeof out.api_key.secret === "string" ? out.api_key.secret : "";
    st.store.createAccount("osobni");
    reloadAccounts(st);
    await jbody(app, "PUT", "/api/accounts/osobni/keys/api", { key: "good-key-123456" }, authed(cookie));
    const now = Date.now() / 1000;
    st.db.addSnapshot({
      ts: now,
      account: "osobni",
      pool: "api",
      used_eur: 0.5,
      initial_eur: 10,
      reset_at: now + 14 * 86400,
      currency: "EUR",
    });
    const r = await jpost(app, "/v1/chat/completions", { model: "m" }, { authorization: `Bearer ${key}` });
    expect(r.status).toBe(200);
    const upstream = st.db.recent();
    expect(upstream.length).toBeGreaterThan(0);
    const ledger: unknown = await (await api(app, "/api/ledger", { headers: authed(cookie) })).json();
    expect(Array.isArray(ledger) && ledger.length > 0).toBe(true);
    const usageR = await api(app, "/api/usage", { headers: authed(cookie) });
    expect(usageR.status).toBe(200);
    const u: unknown = await usageR.json();
    expect(isRec(u) && Array.isArray(u.series)).toBe(true);
    const summary = await api(app, "/api/summary", { headers: authed(cookie) });
    expect(summary.status).toBe(200);
    expect(must(st.lastSync)).toBeGreaterThan(0);
  });
});

describe("config migration", () => {
  it("runs once and does not resurrect deleted accounts", () => {
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    cfg.accounts.push({ name: "old", keys: { api: "literal-key-12345" }, priority: 100, enabled: true, manual: {} });
    cfg.clients.push({ name: "t", token: "tok-1" });
    const st = createState(cfg, upstream as FetchLike);
    expect(st.store.listAccounts().map((a) => a.name)).toEqual(["old"]);
    expect(st.store.verifyApiKey("tok-1")?.name).toBe("t");
    st.store.deleteAccount("old");
    st.store.migrateConfig(cfg);
    expect(st.store.listAccounts()).toEqual([]);
  });
});

describe("Vibe console endpoints", () => {
  it("forwards whoami to the console with the Vibe key", async () => {
    const seen: string[] = [];
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    cfg.accounts = [{ name: "a", keys: { vibe: "vk" }, priority: 100, enabled: true, manual: {} }];
    const st = createState(cfg, ((url: string, init?: RequestInit) => {
      seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      return Promise.resolve(
        json({ plan_type: "chat", plan_name: "INDIVIDUAL", first_name: "Ada", api_base: "https://api.mistral.ai" }),
      );
    }) as FetchLike);
    const app = createApp(st, { webDir: WEB_DIR });
    const w = await api(app, "/api/vibe/whoami");
    expect(w.status).toBe(200);
    expect(await w.json()).not.toHaveProperty("api_base");
    expect(seen).toEqual(["https://console.mistral.ai/api/vibe/whoami Bearer vk"]);
  });
  it("needs a Mistwatch key once keys exist", async () => {
    const { app, st } = mkApp();
    st.store.createApiKey("k");
    const r = await api(app, "/api/vibe/whoami");
    expect(r.status).toBe(401);
  });
});

describe("key owner", () => {
  it("reads who Mistral says a key belongs to", async () => {
    const cfg = defaultConfig();
    cfg.db_path = ":memory:";
    cfg.accounts = [{ name: "a", keys: { vibe: "vk" }, priority: 100, enabled: true, manual: {} }];
    const fetchFn = ((url: string) => {
      const p = new URL(url).pathname;
      if (p === "/v1/users/me")
        return Promise.resolve(
          json({ id: "u", first_name: "Ada", last_name: "L", email: "a@x.io", organization: { name: "Org" } }),
        );
      if (p === "/api/vibe/whoami") return Promise.resolve(json({ plan_type: "chat", plan_name: "Pro" }));
      return Promise.resolve(json({}, 404));
    }) as FetchLike;
    const ownerSt = createState(cfg, fetchFn);
    const app = createApp(ownerSt, { webDir: WEB_DIR });
    const { cookie } = await login(app);
    const r = await api(app, "/api/accounts/a/owner", { headers: authed(cookie) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      vibe: { name: "Ada L", email: "a@x.io", workspace: null, organization: "Org", plan: "Pro", kind: "chat" },
      api: null,
    });
  });
});

describe("keys find their owner", () => {
  const owners: Record<string, { email: string; kind: string }> = {
    "vibe-key-ada-123": { email: "ada@x.io", kind: "chat" },
    "api-key-ada-1234": { email: "ada@x.io", kind: "api" },
    "api-key-bob-1234": { email: "bob@x.io", kind: "api" },
  };
  const fetchFn = ((url: string, init?: RequestInit) => {
    const key = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const o = owners[key];
    const p = new URL(url).pathname;
    if (!o) return Promise.resolve(json({}, 401));
    if (p === "/v1/billing/budget")
      return Promise.resolve(
        json({
          [o.kind === "chat" ? "vibe_budget" : "api_budget"]: {
            usage_percentage: 10,
            initial_budget: 100,
            reset_at: "2099-01-01T00:00:00Z",
          },
        }),
      );
    if (p === "/v1/users/me") return Promise.resolve(json({ id: o.email, email: o.email, first_name: "X" }));
    if (p === "/api/vibe/whoami") return Promise.resolve(json({ plan_type: o.kind, plan_name: "P" }));
    return Promise.resolve(json({ data: [] }));
  }) as FetchLike;
  const names = async (app: Hono, cookie: string): Promise<Record<string, string[]>> => {
    const r = (await (await api(app, "/api/accounts", { headers: authed(cookie) })).json()) as {
      accounts: { name: string; keys: Record<string, unknown> }[];
    };
    return Object.fromEntries(r.accounts.map((a) => [a.name, Object.keys(a.keys).filter((k) => a.keys[k])]));
  };
  it("puts a pasted key under its owner, one account per person, one key per pool", async () => {
    const { app } = mkApp({}, fetchFn);
    const { cookie } = await login(app);
    const add = (key: string) => jpost(app, "/api/keys/add", { key }, authed(cookie));
    expect((await add("vibe-key-ada-123")).status).toBe(200);
    expect((await add("api-key-ada-1234")).status).toBe(200);
    expect((await add("api-key-bob-1234")).status).toBe(200);
    expect(await names(app, cookie)).toEqual({ "ada@x.io": ["vibe", "api"], "bob@x.io": ["api"] });
    expect((await add("api-key-ada-1234")).status).toBe(200);
    expect(Object.keys(await names(app, cookie))).toHaveLength(2);
    expect((await add("nope-nope-nope-1")).status).toBe(400);
  });
  it("moves a signed-in account to its owner and drops the temporary one", async () => {
    const { app, st } = mkApp({}, fetchFn);
    const { cookie } = await login(app);
    st.store.createAccount("pending-1");
    st.store.setKey("pending-1", "vibe", { value: "vibe-key-ada-123" });
    reloadAccounts(st);
    const r = await jpost(app, "/api/accounts/pending-1/adopt", {}, authed(cookie));
    expect(r.status).toBe(200);
    expect(await names(app, cookie)).toEqual({ "ada@x.io": ["vibe"] });
  });
  it("no longer creates accounts by name", async () => {
    const { app } = mkApp({}, fetchFn);
    const { cookie } = await login(app);
    expect((await jpost(app, "/api/accounts", { name: "x" }, authed(cookie))).status).toBe(404);
  });
});
