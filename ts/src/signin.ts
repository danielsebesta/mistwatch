import { createHash, randomBytes } from "node:crypto";
import type { Pool, SignInAttempt, SignInStatus, SyncedPools } from "../shared/api.ts";
import type { DB } from "./db.ts";
import type { Store } from "./store.ts";
import { syncAll, USER_AGENT } from "./sync.ts";
import type { Config, FetchLike } from "./types.ts";
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}
export type SignInApi = {
  start(account: string, pool: Pool): Promise<SignInAttempt>;
  get(id: string): SignInAttempt | undefined;
  cancel(id: string): boolean;
};
export type SignInDeps = {
  cfg: Config;
  db: DB;
  store: Store;
  fetch: FetchLike;
  blockedUntil?: Map<string, number> | undefined;
  onSynced?: (() => void) | undefined;
  pollIntervalS?: number | undefined;
};
export const CONSOLE_URL = "https://console.mistral.ai";
export const API_URL = `${CONSOLE_URL}/api`;
export const MAX_ACTIVE = 5;
export const KEEP_FINISHED_S = 600;
export const WORKSPACE_DENIED_CODE = 9004;
export const WORKSPACE_DENIED_MSG =
  "This workspace cannot be used for Vibe. Sign in again and choose a different workspace in the browser, or contact your administrator.";
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errName = (e: unknown): string => (e instanceof Error ? e.name : "Error");
const normPath = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
};
const checkUrl = (value: unknown, base: string): string => {
  const bad = (): never => {
    throw new SignInError("Mistral returned an unexpected sign-in URL.");
  };
  if (typeof value !== "string") return bad();
  let u: URL;
  let b: URL;
  try {
    u = new URL(value);
    b = new URL(base);
  } catch {
    return bad();
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.origin !== b.origin) return bad();
  const basePath = normPath(b.pathname).replace(/\/+$/, "");
  const path = normPath(u.pathname);
  if (basePath !== "" && path !== basePath && !path.startsWith(`${basePath}/`)) return bad();
  return value;
};
export const pkcePair = (): [string, string] => {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return [verifier, challenge];
};
type AttemptRec = {
  id: string;
  account: string;
  pool: Pool;
  processId: string;
  signInUrl: string;
  pollUrl: string;
  verifier: string;
  expiresAt: number;
  status: SignInStatus;
  message: string;
  synced: SyncedPools;
  finishedAt: number;
  ctrl: AbortController;
  task: Promise<void> | null;
};
type Starting = { account: string; pool: Pool; ctrl: AbortController };
const pub = (a: AttemptRec): SignInAttempt => ({
  id: a.id,
  account: a.account,
  pool: a.pool,
  status: a.status,
  message: a.message,
  sign_in_url: a.signInUrl,
  expires_at: a.expiresAt,
  synced: a.synced,
});
export const createSignIn = (deps: SignInDeps): SignInApi => {
  const pollInterval = deps.pollIntervalS ?? 3.0;
  const attempts = new Map<string, AttemptRec>();
  const starting = new Set<Starting>();
  const finish = (a: AttemptRec, status: SignInStatus, message = ""): void => {
    a.status = status;
    a.message = message;
    a.finishedAt = Date.now() / 1000;
  };
  const gc = (): void => {
    const now = Date.now() / 1000;
    for (const [k, a] of attempts) {
      if (a.finishedAt !== 0 && now - a.finishedAt > KEEP_FINISHED_S) attempts.delete(k);
    }
  };
  const sleep = (a: AttemptRec): Promise<void> =>
    new Promise((ok, fail) => {
      const t = setTimeout(ok, pollInterval * 1000);
      t.unref();
      a.ctrl.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          fail(a.ctrl.signal.reason);
        },
        { once: true },
      );
    });
  const exchange = async (a: AttemptRec, exchangeToken: string): Promise<void> => {
    a.status = "exchanging";
    let r: Response;
    try {
      r = await deps.fetch(`${API_URL}/vibe/sign-in/${a.processId}/exchange`, {
        method: "POST",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
        body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: a.verifier }),
        signal: AbortSignal.any([a.ctrl.signal, AbortSignal.timeout(20_000)]),
      });
    } catch (e) {
      if (a.ctrl.signal.aborted) return;
      return finish(a, "error", `Exchanging for a key failed (${errName(e)}).`);
    }
    if (a.ctrl.signal.aborted) return;
    if (!r.ok) {
      let denied = false;
      try {
        const j: unknown = await r.json();
        denied = r.status === 403 && isRec(j) && j.error_code === WORKSPACE_DENIED_CODE;
      } catch {
        // body unreadable: not the workspace-denied shape
      }
      return finish(a, "error", denied ? WORKSPACE_DENIED_MSG : `Exchanging for a key failed (HTTP ${r.status}).`);
    }
    let key: unknown;
    try {
      const j: unknown = await r.json();
      key = isRec(j) ? j.api_key : undefined;
    } catch {
      key = undefined;
    }
    if (a.ctrl.signal.aborted) return;
    if (typeof key !== "string" || key === "") return finish(a, "error", "Mistral did not return an API key.");
    try {
      deps.store.setKey(a.account, a.pool, { value: key });
    } catch (e) {
      return finish(a, "error", e instanceof Error ? e.message : String(e));
    }
    deps.cfg.accounts.splice(0, deps.cfg.accounts.length, ...deps.store.listAccounts());
    deps.blockedUntil?.clear();
    try {
      a.synced = (await syncAll(deps.fetch, deps.cfg, deps.db))[a.account] ?? {};
      deps.onSynced?.();
    } catch (e) {
      console.error("sync after sign-in", e);
    }
    if (a.ctrl.signal.aborted) return;
    finish(a, "done", "Signed in.");
  };
  const run = async (a: AttemptRec): Promise<void> => {
    let fails = 0;
    try {
      while (Date.now() / 1000 < a.expiresAt) {
        let p: Record<string, unknown>;
        try {
          const r = await deps.fetch(a.pollUrl, {
            redirect: "manual",
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.any([a.ctrl.signal, AbortSignal.timeout(20_000)]),
          });
          if (r.status === 410) return finish(a, "expired", "Sign-in expired.");
          if (!r.ok) throw new Error(`status ${r.status}`);
          const j: unknown = await r.json();
          if (!isRec(j)) throw new TypeError("bad poll payload");
          p = j;
          fails = 0;
        } catch {
          if (a.ctrl.signal.aborted) return;
          fails += 1;
          if (fails >= 3) return finish(a, "error", "Could not check the sign-in status.");
          await sleep(a);
          continue;
        }
        const status = p.status;
        if (status === "pending") {
          await sleep(a);
        } else if (status === "completed") {
          const tok = p.exchange_token;
          if (typeof tok !== "string" || tok === "")
            return finish(a, "error", "Sign-in succeeded, but the token to finish it is missing.");
          return await exchange(a, tok);
        } else if (status === "expired") {
          return finish(a, "expired", "Sign-in expired.");
        } else if (status === "denied") {
          return finish(a, "denied", "Sign-in was denied.");
        } else {
          return finish(a, "error", typeof p.message === "string" && p.message !== "" ? p.message : "Sign-in failed.");
        }
      }
      finish(a, "expired", "Sign-in expired.");
    } catch (e) {
      if (a.ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      console.error("sign-in task failed", e);
      finish(a, "error", "Unexpected error during sign-in.");
    }
  };
  const start = async (account: string, pool: Pool): Promise<SignInAttempt> => {
    gc();
    for (const a of [...attempts.values()]) {
      if (a.account === account && a.pool === pool && (a.status === "pending" || a.status === "exchanging"))
        cancel(a.id);
    }
    for (const s of starting) if (s.account === account && s.pool === pool) s.ctrl.abort();
    let active = 0;
    for (const s of starting) if (!s.ctrl.signal.aborted) active += 1;
    for (const a of attempts.values()) if (a.status === "pending" || a.status === "exchanging") active += 1;
    if (active >= MAX_ACTIVE) throw new SignInError("Too many sign-ins in progress.");
    const slot: Starting = { account, pool, ctrl: new AbortController() };
    starting.add(slot);
    try {
      return await begin(slot);
    } finally {
      starting.delete(slot);
    }
  };
  const begin = async (slot: Starting): Promise<SignInAttempt> => {
    const { account, pool } = slot;
    const [verifier, challenge] = pkcePair();
    let r: Response;
    try {
      r = await deps.fetch(`${API_URL}/vibe/sign-in`, {
        method: "POST",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
        body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
        signal: AbortSignal.any([slot.ctrl.signal, AbortSignal.timeout(20_000)]),
      });
    } catch (e) {
      if (slot.ctrl.signal.aborted) throw new SignInError("Replaced by a newer sign-in for this account.");
      throw new SignInError(`Cannot reach Mistral (${errName(e)}).`);
    }
    if (slot.ctrl.signal.aborted) throw new SignInError("Replaced by a newer sign-in for this account.");
    if (!r.ok) throw new SignInError(`Mistral refused to start the sign-in (HTTP ${r.status}).`);
    let a: AttemptRec;
    try {
      const d: unknown = await r.json();
      if (!isRec(d)) throw new TypeError("bad sign-in payload");
      if (d.process_id === undefined || d.process_id === null) throw new TypeError("missing process_id");
      if (typeof d.expires_at !== "string") throw new TypeError("missing expires_at");
      const exp = Date.parse(d.expires_at);
      if (Number.isNaN(exp)) throw new TypeError("bad expires_at");
      a = {
        id: randomBytes(12).toString("base64url"),
        account,
        pool,
        processId: String(d.process_id),
        signInUrl: checkUrl(d.sign_in_url, CONSOLE_URL),
        pollUrl: checkUrl(d.poll_url, API_URL),
        verifier,
        expiresAt: exp / 1000,
        status: "pending",
        message: "",
        synced: {},
        finishedAt: 0,
        ctrl: new AbortController(),
        task: null,
      };
    } catch (e) {
      if (e instanceof SignInError) throw e;
      throw new SignInError("Mistral returned an unexpected response.");
    }
    if (slot.ctrl.signal.aborted) throw new SignInError("Replaced by a newer sign-in for this account.");
    attempts.set(a.id, a);
    a.task = run(a);
    return pub(a);
  };
  const get = (id: string): SignInAttempt | undefined => {
    const a = attempts.get(id);
    return a === undefined ? undefined : pub(a);
  };
  const cancel = (id: string): boolean => {
    const a = attempts.get(id);
    if (!a) return false;
    if (a.status === "pending" || a.status === "exchanging") finish(a, "cancelled", "Sign-in cancelled.");
    a.ctrl.abort();
    return true;
  };
  return { start, get, cancel };
};
