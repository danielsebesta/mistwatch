import { poolStatusDict } from "./budget.ts";
import { keyFor } from "./config.ts";
import { asException, errors } from "./errors.ts";
import type { State } from "./state.ts";

// What other tools can read from Mistwatch: the Vibe CLI's plan, name and budget footer, and the limit windows.
export type Client = { id: number; name: string } | null;

export const authClient = (st: State, authorization: string | null, xApiKey: string | null): Client => {
  if (!st.store.hasApiKeys()) return null;
  const auth = authorization ?? "";
  const tok = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : (xApiKey ?? "");
  const k = st.store.verifyApiKey(tok.trim());
  if (k === null) throw asException(errors.auth());
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

// Vibe rewrites its provider address from these two fields; left in, they would send it past Mistwatch.
const dropTenantUrls = (body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof j !== "object" || j === null || Array.isArray(j)) return body;
    const { api_base: _a, vibe_base: _v, ...rest } = j as Record<string, unknown>;
    return new TextEncoder().encode(JSON.stringify(rest));
  } catch {
    return body;
  }
};

// Plan and name come from Mistral itself: forward with the first key that has a Vibe pool.
export const consoleForward = async (st: State, path: string): Promise<Response> => {
  const acct =
    st.cfg.accounts.find((a) => a.enabled && keyFor(a, "vibe")) ??
    st.cfg.accounts.find((a) => a.enabled && Object.keys(a.keys).length > 0);
  const key = acct ? (keyFor(acct, "vibe") ?? keyFor(acct, Object.keys(acct.keys)[0] ?? "")) : null;
  if (!key) return Response.json({ error: "no account key" }, { status: 404 });
  try {
    const r = await st.fetch(`${st.cfg.console_upstream}${path}`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "mistwatch/0.2" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    let body: Uint8Array<ArrayBuffer> = new Uint8Array(await r.arrayBuffer());
    if (r.ok && path.endsWith("/whoami")) body = dropTenantUrls(body);
    return new Response(body, {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: "console unreachable" }, { status: 502 });
  }
};
