import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import { resolveSecret } from "./config.ts";
import type { DB } from "./db.ts";
import { hashPasswordAsync, verifyPasswordAsync } from "./security.ts";
import type { Account, ApiKeyRow, Config, KeyInfo, KeySource, ManualPool, SessionUser, UserRow } from "./types.ts";
import { POOLS } from "./types.ts";
export const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
export const ACCOUNT_RE = /^[A-Za-z0-9._+@-]{1,80}$/;
export const SESSION_TTL = 30 * 86400;
export const SESSION_IDLE_S = 7 * 86400;
const SESSION_TOUCH_S = 60;
export const KEYRING_SERVICE = "mistwatch";
export const VIBE_REF = "keyring:ai.mistral.vibe/MISTRAL_API_KEY";
export const MIN_PASSWORD = 10;
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}
const LOG_N = 15;
const R = 8;
const P = 1;
const scrypt = (pw: string, salt: Buffer, logN: number, r: number, p: number): Buffer =>
  scryptSync(pw, salt, 32, { N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 });
export const hashPassword = (pw: string): string => {
  const salt = randomBytes(16);
  const dk = scrypt(pw, salt, LOG_N, R, P);
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64")}$${dk.toString("base64")}`;
};
export const verifyPassword = (pw: string, stored: string): boolean => {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [ln, r, p, salt64, dk64] = [parts[1] ?? "", parts[2] ?? "", parts[3] ?? "", parts[4] ?? "", parts[5] ?? ""];
    if (!/^[+-]?\d+$/.test(ln) || !/^[+-]?\d+$/.test(r) || !/^[+-]?\d+$/.test(p)) return false;
    const calc = scrypt(pw, Buffer.from(salt64, "base64"), Number(ln), Number(r), Number(p));
    const want = Buffer.from(dk64, "base64");
    return calc.length === want.length && timingSafeEqual(calc, want);
  } catch {
    return false;
  }
};
let dummy: string | null = null;
const dummyHash = (): string => (dummy ??= hashPassword("dummy-password-for-timing"));
let dummyAsync: Promise<string> | null = null;
const dummyHashAsync = (): Promise<string> => (dummyAsync ??= hashPasswordAsync("dummy-password-for-timing"));
const sha = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
export const checkPasswordPolicy = (pw: string): void => {
  if (pw.length < MIN_PASSWORD) throw new StoreError(`Password must be at least ${MIN_PASSWORD} characters.`);
  if (pw.length > 256) throw new StoreError("Password is too long.");
};
export const refKind = (ref: string): KeySource =>
  ref === VIBE_REF ? "vibe-cli" : ref.startsWith("keyring:") ? "keyring" : ref.startsWith("env:") ? "env" : "inline";
export const mask = (key: string): string =>
  key.length > 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : `…${key.slice(-3)}`;
export const saveSecret = (account: string, pool: string, value: string): string => {
  if (process.env.MISTWATCH_NO_KEYRING) return value;
  try {
    const user = `${account}/${pool}`;
    const e = new Entry(KEYRING_SERVICE, user);
    e.setPassword(value);
    if (e.getPassword() === value) return `keyring:${KEYRING_SERVICE}/${user}`;
  } catch {
    // no usable keyring on this machine
  }
  return value;
};
export const dropSecret = (ref: string): void => {
  if (!ref.startsWith(`keyring:${KEYRING_SERVICE}/`)) return;
  try {
    const rest = ref.slice(8);
    new Entry(KEYRING_SERVICE, rest.slice(rest.indexOf("/") + 1)).deletePassword();
  } catch {
    // best effort: a missing keyring entry is fine
  }
};
export const vibeCliKeyPresent = (): boolean => {
  try {
    return Boolean(new Entry("ai.mistral.vibe", "MISTRAL_API_KEY").getPassword());
  } catch {
    return false;
  }
};
type Row = Record<string, unknown>;
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new TypeError("db: expected string");
  return v;
};
const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new TypeError("db: expected number");
};
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSpace = (c: string): boolean => {
  const cp = c.codePointAt(0);
  return cp !== undefined && (/\s/u.test(c) || (cp >= 0x1c && cp <= 0x1f) || cp === 0x85);
};
const parseKeys = (v: unknown): Record<string, string> => {
  const o: unknown = JSON.parse(str(v));
  if (!isRec(o)) throw new TypeError("accounts.keys is not an object");
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) {
    if (typeof x !== "string") throw new TypeError("accounts.keys values must be strings");
    out[k] = x;
  }
  return out;
};
const parseManual = (v: unknown): Record<string, ManualPool> => {
  const o: unknown = JSON.parse(str(v));
  if (!isRec(o)) throw new TypeError("accounts.manual is not an object");
  const out: Record<string, ManualPool> = {};
  for (const [pool, mv] of Object.entries(o)) {
    if (!isRec(mv)) throw new TypeError("accounts.manual values must be objects");
    const mp: ManualPool = {};
    for (const [k, x] of Object.entries(mv)) {
      if (typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean")
        throw new TypeError("accounts.manual values must be primitives");
      mp[k] = x;
    }
    out[pool] = mp;
  }
  return out;
};
export const createStore = (db: DB) => {
  const touched = new Map<number, number>();
  const one = (sql: string, args: (string | number | null)[] = []): Row | undefined => db.stmt(sql).get(...args);
  const run = (sql: string, ...args: (string | number | null)[]) => db.stmt(sql).run(...args);
  const countUsers = (): number => num(one("SELECT COUNT(*) c FROM users")?.c ?? 0);
  const insertKey = (name: string, secret: string, now: number): void => {
    run(
      "INSERT INTO api_keys(name, prefix, key_hash, created) VALUES(?,?,?,?)",
      name,
      secret.slice(0, 7),
      sha(secret),
      now,
    );
  };
  const listApiKeys = (name?: string): ApiKeyRow[] =>
    (name === undefined
      ? db.stmt("SELECT id, name, prefix, created, last_used FROM api_keys ORDER BY id").all()
      : db.stmt("SELECT id, name, prefix, created, last_used FROM api_keys WHERE name=?").all(name)
    ).map((r) => ({
      id: num(r.id),
      name: str(r.name),
      prefix: str(r.prefix),
      created: num(r.created),
      last_used: optNum(r.last_used),
    }));
  const accountOf = (r: Row): Account => ({
    name: str(r.name),
    keys: parseKeys(r.keys),
    priority: num(r.priority),
    enabled: num(r.enabled) !== 0,
    manual: parseManual(r.manual),
  });
  const getAccount = (name: string): Account | null => {
    const r = one("SELECT * FROM accounts WHERE name=?", [name]);
    return r ? accountOf(r) : null;
  };
  const createAccount = (name: string, priority = 100, now = Date.now() / 1000): void => {
    const n = name.trim();
    if (!ACCOUNT_RE.test(n))
      throw new StoreError("Account name (may be an e-mail): 1-80 characters, letters, digits and . _ + @ -");
    if (getAccount(n)) throw new StoreError("An account with this name already exists.");
    run("INSERT INTO accounts(name, priority, created) VALUES(?,?,?)", n, priority, now);
  };
  const updateAccount = (name: string, enabled?: boolean | null, priority?: number | null): void => {
    db.tx(() => {
      if (enabled != null) run("UPDATE accounts SET enabled=? WHERE name=?", enabled ? 1 : 0, name);
      if (priority != null) run("UPDATE accounts SET priority=? WHERE name=?", Math.trunc(priority), name);
    });
  };
  const setKey = (
    name: string,
    pool: string,
    opts: { value?: string | null | undefined; ref?: string | null | undefined } = {},
  ): void => {
    if (!POOLS.some((p) => p === pool)) throw new StoreError("Unknown pool.");
    const acct = getAccount(name);
    if (!acct) throw new StoreError("Account does not exist.");
    let newRef: string;
    if (opts.value != null) {
      const v = opts.value.trim();
      if (v.length < 8 || [...v].some(isSpace)) throw new StoreError("Key looks invalid.");
      newRef = saveSecret(name, pool, v);
    } else if (opts.ref) {
      newRef = opts.ref;
    } else {
      throw new StoreError("Key is missing.");
    }
    const old = acct.keys[pool];
    if (old && old !== newRef) dropSecret(old);
    acct.keys[pool] = newRef;
    run("UPDATE accounts SET keys=? WHERE name=?", JSON.stringify(acct.keys), name);
  };
  return {
    countUsers,
    listUsers: (): UserRow[] =>
      db
        .stmt("SELECT id, username, created FROM users ORDER BY id")
        .all()
        .map((r) => ({ id: num(r.id), username: str(r.username), created: num(r.created) })),
    createUser: (username: string, password: string, now = Date.now() / 1000): number => {
      const name = username.trim();
      if (!/^[A-Za-z0-9._@-]{2,40}$/.test(name))
        throw new StoreError("Username: 2-40 characters, letters, digits and . _ - @");
      checkPasswordPolicy(password);
      if (one("SELECT 1 FROM users WHERE username=?", [name]))
        throw new StoreError("A user with this name already exists.");
      return Number(
        run("INSERT INTO users(username, pw_hash, created) VALUES(?,?,?)", name, hashPassword(password), now)
          .lastInsertRowid,
      );
    },
    verifyLogin: (username: string, password: string): SessionUser | null => {
      const r = one("SELECT id, username, pw_hash FROM users WHERE username=?", [username.trim()]);
      if (!r) {
        verifyPassword(password, dummyHash());
        return null;
      }
      return verifyPassword(password, str(r.pw_hash)) ? { id: num(r.id), username: str(r.username) } : null;
    },
    createUserAsync: async (username: string, password: string, now = Date.now() / 1000): Promise<number> => {
      const name = username.trim();
      if (!/^[A-Za-z0-9._@-]{2,40}$/.test(name))
        throw new StoreError("Username: 2-40 characters, letters, digits and . _ - @");
      checkPasswordPolicy(password);
      if (one("SELECT 1 FROM users WHERE username=?", [name]))
        throw new StoreError("A user with this name already exists.");
      return Number(
        run("INSERT INTO users(username, pw_hash, created) VALUES(?,?,?)", name, await hashPasswordAsync(password), now)
          .lastInsertRowid,
      );
    },
    verifyLoginAsync: async (username: string, password: string): Promise<SessionUser | null> => {
      const r = one("SELECT id, username, pw_hash FROM users WHERE username=?", [username.trim()]);
      const hash = r ? str(r.pw_hash) : await dummyHashAsync();
      const ok = await verifyPasswordAsync(password, hash);
      return ok && r ? { id: num(r.id), username: str(r.username) } : null;
    },
    setPasswordAsync: async (userId: number, password: string): Promise<void> => {
      checkPasswordPolicy(password);
      run("UPDATE users SET pw_hash=? WHERE id=?", await hashPasswordAsync(password), userId);
    },
    checkUserPasswordAsync: async (userId: number, password: string): Promise<boolean> => {
      const r = one("SELECT pw_hash FROM users WHERE id=?", [userId]);
      return r !== undefined && (await verifyPasswordAsync(password, str(r.pw_hash)));
    },
    setPassword: (userId: number, password: string): void => {
      checkPasswordPolicy(password);
      run("UPDATE users SET pw_hash=? WHERE id=?", hashPassword(password), userId);
    },
    checkUserPassword: (userId: number, password: string): boolean => {
      const r = one("SELECT pw_hash FROM users WHERE id=?", [userId]);
      return r !== undefined && verifyPassword(password, str(r.pw_hash));
    },
    deleteUser: (userId: number): void => {
      if (countUsers() <= 1) throw new StoreError("The last user cannot be deleted.");
      db.tx(() => {
        run("DELETE FROM sessions WHERE user_id=?", userId);
        run("DELETE FROM users WHERE id=?", userId);
      });
    },
    findUser: (username: string): SessionUser | null => {
      const r = one("SELECT id, username FROM users WHERE username=?", [username]);
      return r ? { id: num(r.id), username: str(r.username) } : null;
    },
    createSession: (userId: number, now = Date.now() / 1000): string => {
      const tok = randomBytes(32).toString("base64url");
      db.tx(() => {
        run("DELETE FROM sessions WHERE expires<? OR last_seen<?", now, now - SESSION_IDLE_S);
        run(
          "INSERT INTO sessions(token_hash, user_id, created, last_seen, expires) VALUES(?,?,?,?,?)",
          sha(tok),
          userId,
          now,
          now,
          now + SESSION_TTL,
        );
      });
      return tok;
    },
    getSession: (token: string | null | undefined, now = Date.now() / 1000): SessionUser | null => {
      if (!token) return null;
      const r = one(
        "SELECT u.id id, u.username username, s.expires expires, s.last_seen last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
        [sha(token)],
      );
      if (!r || num(r.expires) < now || now - num(r.last_seen) > SESSION_IDLE_S) return null;
      if (now - num(r.last_seen) > SESSION_TOUCH_S)
        run("UPDATE sessions SET last_seen=? WHERE token_hash=?", now, sha(token));
      return { id: num(r.id), username: str(r.username) };
    },
    deleteSession: (token: string | null | undefined): void => {
      if (token) run("DELETE FROM sessions WHERE token_hash=?", sha(token));
    },
    deleteOtherSessions: (userId: number, keepToken: string | null | undefined): void => {
      run("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", userId, sha(keepToken || ""));
    },
    hasApiKeys: () => one("SELECT 1 FROM api_keys LIMIT 1") !== undefined,
    createApiKey: (name: string, now = Date.now() / 1000): [ApiKeyRow, string] => {
      const n = name.trim();
      if (!NAME_RE.test(n)) throw new StoreError("Key name: 1-40 characters, letters, digits and . _ -");
      if (one("SELECT 1 FROM api_keys WHERE name=?", [n])) throw new StoreError("A key with this name already exists.");
      const secret = `mw-${randomBytes(32).toString("base64url")}`;
      insertKey(n, secret, now);
      const row = listApiKeys(n)[0];
      if (!row) throw new Error("api key insert failed");
      return [row, secret];
    },
    listApiKeys,
    deleteApiKey: (keyId: number): boolean => Number(run("DELETE FROM api_keys WHERE id=?", keyId).changes) > 0,
    verifyApiKey: (token: string | null | undefined, now = Date.now() / 1000): { id: number; name: string } | null => {
      if (!token) return null;
      const r = one("SELECT id, name FROM api_keys WHERE key_hash=?", [sha(token)]);
      if (!r) return null;
      const kid = num(r.id);
      if (now - (touched.get(kid) ?? 0) > 60) {
        touched.set(kid, now);
        run("UPDATE api_keys SET last_used=? WHERE id=?", now, kid);
      }
      return { id: kid, name: str(r.name) };
    },
    listAccounts: (): Account[] => db.stmt("SELECT * FROM accounts ORDER BY priority, id").all().map(accountOf),
    getAccount,
    createAccount,
    updateAccount,
    deleteAccount: (name: string): void => {
      const acct = getAccount(name);
      if (acct) for (const ref of Object.values(acct.keys)) dropSecret(ref);
      run("DELETE FROM accounts WHERE name=?", name);
    },
    setKey,
    removeKey: (name: string, pool: string): void => {
      const acct = getAccount(name);
      if (!acct || !(pool in acct.keys)) return;
      const ref = acct.keys[pool];
      if (ref !== undefined) dropSecret(ref);
      delete acct.keys[pool];
      run("UPDATE accounts SET keys=? WHERE name=?", JSON.stringify(acct.keys), name);
    },
    keyInfo: (acct: Account): Record<string, KeyInfo | null> => {
      const out: Record<string, KeyInfo | null> = {};
      for (const pool of POOLS) {
        const ref = acct.keys[pool];
        if (!ref) {
          out[pool] = null;
          continue;
        }
        const info: KeyInfo = { source: refKind(ref), hint: null, ok: true };
        try {
          info.hint = mask(resolveSecret(ref));
        } catch (e) {
          info.ok = false;
          info.error = e instanceof Error ? e.message : String(e);
        }
        out[pool] = info;
      }
      return out;
    },
    migrateConfig: (cfg: Config): void => {
      if (one("SELECT 1 FROM meta WHERE k='config_migrated'")) return;
      db.tx(() => {
        for (const a of cfg.accounts) {
          if (getAccount(a.name)) continue;
          createAccount(a.name, a.priority);
          for (const [pool, ref] of Object.entries(a.keys)) {
            const keep = /^(env|keyring):/.test(ref) ? ref : saveSecret(a.name, pool, ref);
            setKey(a.name, pool, { ref: keep });
          }
          updateAccount(a.name, a.enabled);
          if (Object.keys(a.manual).length)
            run("UPDATE accounts SET manual=? WHERE name=?", JSON.stringify(a.manual), a.name);
        }
        for (const c of cfg.clients) {
          if (!one("SELECT 1 FROM api_keys WHERE name=?", [c.name])) insertKey(c.name, c.token, Date.now() / 1000);
        }
        run("INSERT INTO meta(k, v) VALUES('config_migrated','1')");
      });
    },
  };
};
export type Store = ReturnType<typeof createStore>;
