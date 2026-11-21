import { poolStatusDict, WINDOWS } from "./budget.ts";
import { keyFor } from "./config.ts";
import { asException, errors } from "./errors.ts";
import { isExposed } from "./security.ts";
import type { State } from "./state.ts";

// What other tools can read from Mistwatch: the Vibe CLI's plan, name and budget footer, and the limit windows.
export type Client = { id: number; name: string } | null;

// Checks the Mistwatch key. The per-IP budget and the lock after wrong keys run first, before any database lookup.
// An exposed server (non-loopback address, reverse proxy, extra hosts) never runs without a key.
export const authClient = (st: State, authorization: string | null, xApiKey: string | null, ip = "?"): Client => {
  st.guard.before(ip);
  if (!st.store.hasApiKeys()) {
    if (isExposed(st.cfg)) throw asException(errors.auth());
    return null;
  }
  const auth = authorization ?? "";
  const tok = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : (xApiKey ?? "");
  const k = st.store.verifyApiKey(tok.trim().slice(0, 256));
  if (k === null) {
    st.guard.wrongKey(ip);
    throw asException(errors.auth());
  }
  st.guard.rightKey(ip);
  return k;
};

const iso = (s: number): string => new Date(s * 1000).toISOString();

// Pools of one kind, once per account group (grouped accounts share a budget).
const pools = (st: State, pool: "vibe" | "api", now: number) => {
  const seen = new Set<string>();
  const out = [];
  for (const a of st.cfg.accounts) {
    if (!a.enabled) continue;
    const s = st.engine.status(a.name, pool, now);
    if (!s) continue;
    const key = s.group ?? s.account;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
};

// The shape of Mistral's GET /v1/billing/budget, which the Vibe CLI shows in its footer.
export const billingBudget = (st: State, now: number): Record<string, unknown> => {
  const ps = pools(st, "vibe", now);
  if (ps.length === 0) return {};
  const initial = ps.reduce((n, p) => n + p.initial, 0);
  const used = ps.reduce((n, p) => n + p.used, 0);
  const reset = Math.min(...ps.map((p) => p.reset_at));
  return {
    vibe_budget: {
      usage_percentage: initial > 0 ? Math.round((used / initial) * 10_000) / 100 : 0,
      initial_budget: Math.round(initial * 100) / 100,
      reset_at: iso(reset),
      payg_enabled: false,
      currency: "EUR",
    },
  };
};

export const limits = (st: State, now: number) => ({
  now,
  currency: "EUR",
  pools: (["vibe", "api"] as const).flatMap((pool) =>
    pools(st, pool, now).map((s) => {
      const d = poolStatusDict(s);
      return {
        pool,
        account: d.account,
        members: d.members,
        room_eur: d.room_eur,
        blocked_by: d.blocked_by,
        retry_at: d.retry_at === null ? null : iso(d.retry_at),
        reset_at: iso(d.reset_at),
        month: d.month,
        windows: Object.fromEntries(
          Object.entries(d.windows).map(([n, w]) => [
            n,
            { ...w, retry_at: w.retry_at === null ? null : iso(w.retry_at) },
          ]),
        ),
      };
    }),
  ),
});

// "5h=0.4/1.2;day=..." for a response header: room/cap per window, then the month.
export const limitsHeader = (s: ReturnType<typeof poolStatusDict>): string =>
  [
    ...Object.entries(s.windows).map(([n, w]) => `${n}=${w.room}/${w.cap}`),
    `month=${s.month.room}/${s.month.cap}`,
  ].join(";");

const PLAN_TITLES: Record<string, string> = { FREE: "Free", INDIVIDUAL: "Pro", EDU: "Student", TEAM: "Team" };
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The plan comes from Mistral itself, asked once per Vibe key. With several accounts it reads "Pro + Pro + Team".
export const whoami = async (st: State): Promise<Response> => {
  const keys = new Set<string>();
  for (const a of st.cfg.accounts) {
    if (!a.enabled) continue;
    try {
      const k = keyFor(a, "vibe") ?? keyFor(a, Object.keys(a.keys)[0] ?? "");
      if (k) keys.add(k);
    } catch {
      // an unreadable key just does not take part
    }
  }
  if (keys.size === 0) return Response.json({ error: "no account key" }, { status: 404 });
  const got = await Promise.all(
    [...keys].map(async (key): Promise<Record<string, unknown> | null> => {
      try {
        const r = await st.fetch(`${st.cfg.console_upstream}/api/vibe/whoami`, {
          headers: { Authorization: `Bearer ${key}`, "User-Agent": "mistwatch/0.2" },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return null;
        const j: unknown = await r.json();
        return isRec(j) ? j : null;
      } catch {
        return null;
      }
    }),
  );
  const ok = got.filter((x): x is Record<string, unknown> => x !== null);
  const first = ok[0];
  if (!first) return Response.json({ error: "console unreachable" }, { status: 502 });
  // Vibe rewrites its provider address from api_base and vibe_base; left in, they would send it past Mistwatch.
  const { api_base: _a, vibe_base: _v, ...rest } = first;
  const names = ok.map((o) => {
    const raw = typeof o.plan_name === "string" ? o.plan_name.trim() : "";
    return PLAN_TITLES[raw.toUpperCase()] ?? raw;
  });
  return Response.json({ ...rest, plan_name: names.filter((n) => n).join(" + ") || rest.plan_name });
};

// The shape of Mistral's GET /users/me, filled from Mistwatch.
export const mistwatchIdentity = (st: State, client: Client) => {
  const first = st.store.listUsers()[0]?.username ?? client?.name ?? "Mistwatch";
  return { id: "mistwatch", first_name: first, last_name: null, email: null };
};

const DAY_S = 86_400;
const cents = (eur: number): number => Math.max(Math.round(eur * 100), 0);
// Standard rate-limit headers (IETF httpapi-ratelimit-headers), so agents and SDKs that know them can back off.
// Units are euro cents: the limit is money, not requests. The plain triple describes the tightest window.
export const rateLimitHeaders = (d: ReturnType<typeof poolStatusDict>, now: number): Record<string, string> => {
  const rows = [
    ...Object.entries(d.windows).map(([n, w]) => ({
      name: n,
      cap: w.cap,
      room: w.room,
      window: Math.round((WINDOWS[n] ?? 1) * DAY_S),
      retry: w.retry_at,
    })),
    {
      name: "month",
      cap: d.month.cap,
      room: d.month.room,
      window: Math.max(Math.round(d.reset_at - now), 1),
      retry: d.month.room <= 0 ? d.reset_at : null,
    },
  ];
  const reset = (r: (typeof rows)[number]): number => Math.max(Math.ceil((r.retry ?? now + r.window) - now), 0);
  const tight = rows.reduce((a, b) => (b.cap > 0 && b.room / b.cap < (a.cap > 0 ? a.room / a.cap : 1) ? b : a));
  return {
    "RateLimit-Policy": rows.map((r) => `"${r.name}";q=${cents(r.cap)};qu="eur-cent";w=${r.window}`).join(", "),
    RateLimit: rows.map((r) => `"${r.name}";r=${cents(r.room)};t=${reset(r)}`).join(", "),
    "RateLimit-Limit": String(cents(tight.cap)),
    "RateLimit-Remaining": String(cents(tight.room)),
    "RateLimit-Reset": String(reset(tight)),
  };
};
