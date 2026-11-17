import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { asException, errors, isAppError } from "./errors.ts";
import { createQueue } from "./queue.ts";
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const safeEqual = (a: string | Uint8Array, b: string | Uint8Array): boolean => {
  const x = typeof a === "string" ? Buffer.from(a, "utf8") : a;
  const y = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  return timingSafeEqual(createHash("sha256").update(x).digest(), createHash("sha256").update(y).digest());
};
const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);
export type HostAllowOpts = { port: number; extraHosts?: readonly string[] | undefined };
const nameAllowed = (name: string, opts: HostAllowOpts): boolean =>
  LOCAL_NAMES.has(name) || (opts.extraHosts?.includes(name) ?? false);
const splitHost = (raw: string): { name: string; port: number | null } | null => {
  const t = raw.trim().toLowerCase();
  if (t === "" || /\s/.test(t)) return null;
  if (t.startsWith("[")) {
    const end = t.indexOf("]");
    if (end < 0) return null;
    const rest = t.slice(end + 1);
    const name = t.slice(1, end);
    if (rest === "") return { name, port: null };
    if (!rest.startsWith(":")) return null;
    const p = Number(rest.slice(1));
    return Number.isInteger(p) && p >= 0 && p <= 65535 ? { name, port: p } : null;
  }
  const i = t.lastIndexOf(":");
  if (i < 0) return { name: t, port: null };
  const name = t.slice(0, i);
  const p = Number(t.slice(i + 1));
  if (name === "" || !Number.isInteger(p) || p < 0 || p > 65535) return null;
  return { name, port: p };
};
export const hostAllowed = (host: string | null | undefined, opts: HostAllowOpts): boolean => {
  if (host === null || host === undefined) return false;
  const p = splitHost(host);
  if (p === null) return false;
  const name = p.name.endsWith(".") ? p.name.slice(0, -1) : p.name;
  return nameAllowed(name, opts) && (p.port === null || p.port === opts.port);
};
export const originAllowed = (origin: string | null | undefined, opts: HostAllowOpts): boolean => {
  if (origin === null || origin === undefined || origin === "") return true;
  if (origin === "null") return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username !== "" || u.password !== "") return false;
  const name = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!nameAllowed(name, opts)) return false;
  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  return port === opts.port;
};
export const localRequestAllowed = (
  h: { host?: string | null | undefined; origin?: string | null | undefined },
  opts: HostAllowOpts,
): boolean => hostAllowed(h.host, opts) && originAllowed(h.origin, opts);
export const HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);
const REQUEST_SECRET = new Set(["authorization", "x-api-key", "cookie", "accept-encoding"]);
const connTokens = (pairs: readonly (readonly [string, string])[]): Set<string> => {
  const out = new Set<string>();
  for (const [k, v] of pairs) {
    if (k.toLowerCase() === "connection") for (const t of v.split(",")) out.add(t.trim().toLowerCase());
  }
  return out;
};
export const filterRequestHeaders = (
  raw: Iterable<readonly [string, string]>,
  extraDrop: Iterable<string> = [],
): [string, string][] => {
  const pairs = [...raw].map(([k, v]): [string, string] => [k, v]);
  const drop = new Set([...HOP_HEADERS, ...REQUEST_SECRET, ...connTokens(pairs)]);
  for (const h of extraDrop) drop.add(h.toLowerCase());
  return pairs.filter(([k]) => {
    const lk = k.toLowerCase();
    return !drop.has(lk) && lk !== "x-mw" && !lk.startsWith("x-mw-");
  });
};
export const filterResponseHeaders = (
  raw: Iterable<readonly [string, string]>,
  extraDrop: Iterable<string> = [],
): [string, string][] => {
  const pairs = [...raw].map(([k, v]): [string, string] => [k, v]);
  const drop = new Set([...HOP_HEADERS, ...connTokens(pairs), "set-cookie"]);
  for (const h of extraDrop) drop.add(h.toLowerCase());
  return pairs.filter(([k]) => !drop.has(k.toLowerCase()));
};
export const bodyWithinLimit = (contentLength: string | null | undefined, limit: number): boolean => {
  if (contentLength === null || contentLength === undefined) return true;
  const n = Number(contentLength);
  return !Number.isFinite(n) || n <= limit;
};
export const readLimitedBody = async (body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> => {
  if (body === null) return new Uint8Array(0);
  const r = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await r.cancel().catch(() => undefined);
        throw asException(errors.tooLarge());
      }
      parts.push(value);
    }
  } finally {
    r.releaseLock();
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of parts) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
};
export const limitBodyStream = (limit: number): TransformStream<Uint8Array, Uint8Array> => {
  let size = 0;
  return new TransformStream({
    transform(chunk, ctrl) {
      size += chunk.byteLength;
      if (size > limit) {
        ctrl.error(asException(errors.tooLarge()));
        return;
      }
      ctrl.enqueue(chunk);
    },
  });
};
export const SCRYPT_LOG_N = 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const MAXMEM = 256 * 1024 * 1024;
const MAX_PW_BYTES = 4096;
const scryptQueue = createQueue({ concurrency: 2, maxPending: 64 });
const derive = (pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  scryptQueue.run(
    () =>
      new Promise<Buffer>((ok, fail) => {
        scrypt(pw, salt, 32, { N: n, r, p, maxmem: MAXMEM }, (e, dk) => (e === null ? ok(dk) : fail(e)));
      }),
  );
export const hashPasswordAsync = async (pw: string): Promise<string> => {
  if (Buffer.byteLength(pw, "utf8") > MAX_PW_BYTES) throw asException(errors.badRequest("Password is too long."));
  const salt = randomBytes(16);
  const dk = await derive(pw, salt, 2 ** SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_LOG_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${dk.toString("base64")}`;
};
const IS_INT = /^[0-9]+$/;
const IS_B64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const verifyPasswordAsync = async (pw: string, stored: string): Promise<boolean> => {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [lnS = "", rS = "", pS = "", saltS = "", dkS = ""] = parts.slice(1);
  if (!IS_INT.test(lnS) || !IS_INT.test(rS) || !IS_INT.test(pS) || !IS_B64.test(saltS) || !IS_B64.test(dkS))
    return false;
  const ln = Number(lnS);
  const r = Number(rS);
  const p = Number(pS);
  const salt = Buffer.from(saltS, "base64");
  const want = Buffer.from(dkS, "base64");
  if (want.length !== 32 || salt.length === 0 || salt.length > 64) return false;
  if (ln < 1 || ln > 24 || r < 1 || r > 64 || p < 1 || p > 32) return false;
  if (128 * r * 2 ** ln > MAXMEM) return false;
  if (Buffer.byteLength(pw, "utf8") > MAX_PW_BYTES) return false;
  try {
    const calc = await derive(pw, salt, 2 ** ln, r, p);
    return timingSafeEqual(calc, want);
  } catch (e) {
    if (isAppError(e)) throw e;
    return false;
  }
};
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/mw-[A-Za-z0-9_-]{12,}/g, "mw-[redacted]"],
];
export const redactSecrets = (text: string, secrets: Iterable<string> = []): string => {
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
};
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const safePathSegment = (name: string): boolean => SAFE_SEGMENT.test(name);
