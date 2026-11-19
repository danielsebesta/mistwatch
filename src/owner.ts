import type { FetchLike } from "./types.ts";

// Who a Mistral key belongs to, as Mistral reports it (GET /v1/users/me, and the plan from /api/vibe/whoami).
export type KeyOwner = {
  name: string | null;
  email: string | null;
  workspace: string | null;
  organization: string | null;
  plan: string | null;
};
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const entity = (v: unknown): string | null => (isRec(v) ? str(v.name) : null);
const getJson = async (fetchFn: FetchLike, url: string, key: string): Promise<Record<string, unknown> | null> => {
  try {
    const r = await fetchFn(url, {
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
};
export const fetchOwner = async (
  fetchFn: FetchLike,
  upstream: string,
  consoleUpstream: string,
  key: string,
  withPlan: boolean,
): Promise<KeyOwner | null> => {
  const [me, who] = await Promise.all([
    getJson(fetchFn, `${upstream}/v1/users/me`, key),
    withPlan ? getJson(fetchFn, `${consoleUpstream}/api/vibe/whoami`, key) : Promise.resolve(null),
  ]);
  if (me === null && who === null) return null;
  const full = [str(me?.first_name), str(me?.last_name)].filter((x) => x !== null).join(" ");
  return {
    name: full || null,
    email: str(me?.email),
    workspace: entity(me?.workspace),
    organization: entity(me?.organization),
    plan: str(who?.plan_name),
  };
};
