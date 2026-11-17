import { beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import {
  checkPasswordPolicy,
  createStore,
  hashPassword,
  mask,
  SESSION_TTL,
  StoreError,
  verifyPassword,
} from "../src/store.ts";
import { must } from "./helpers.ts";

beforeAll(() => {
  process.env.MISTWATCH_NO_KEYRING = "1";
});
describe("passwords", () => {
  it("hash roundtrip, salted and constant-format", () => {
    const h = hashPassword("secret-password");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("secret-password");
    expect(verifyPassword("secret-password", h)).toBe(true);
    expect(verifyPassword("nope", h)).toBe(false);
    expect(hashPassword("secret-password")).not.toBe(h);
  });
  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "scrypt$garbage")).toBe(false);
    expect(verifyPassword("x", "other$15$8$1$AAAA$BBBB")).toBe(false);
    expect(verifyPassword("x", "scrypt$x$8$1$AAAA$BBBB")).toBe(false);
  });
  it("enforces the password policy", () => {
    expect(() => checkPasswordPolicy("short")).toThrow("at least 10");
    expect(() => checkPasswordPolicy("x".repeat(257))).toThrow("too long");
    expect(() => checkPasswordPolicy("1234567890")).not.toThrow();
  });
  it("counts password length in code points, not utf-16 units", () => {
    expect(() => checkPasswordPolicy("😀".repeat(9))).toThrow("at least 10");
    expect(() => checkPasswordPolicy("😀".repeat(10))).not.toThrow();
    expect(() => checkPasswordPolicy(`${"x".repeat(255)}😀`)).not.toThrow();
    expect(() => checkPasswordPolicy(`${"x".repeat(256)}😀`)).toThrow("too long");
  });
});
describe("store", () => {
  it("users, sessions and password change", () => {
    const st = createStore(openDb(":memory:"));
    expect(st.countUsers()).toBe(0);
    const uid = st.createUser(" daniel ", "correct horse battery", 1000);
    expect(() => st.createUser("daniel", "another-long-pass", 1000)).toThrow(StoreError);
    expect(() => st.createUser("bad name!", "another-long-pass", 1000)).toThrow(StoreError);
    expect(() => st.createUser("ok", "short", 1000)).toThrow(StoreError);
    expect(st.verifyLogin("daniel", "wrong")).toBeNull();
    expect(st.verifyLogin("ghost", "wrong")).toBeNull();
    expect(st.verifyLogin("daniel", "correct horse battery")).toEqual({ id: uid, username: "daniel" });
    const tok = st.createSession(uid, 1000);
    expect(st.getSession(tok, 1001)).toEqual({ id: uid, username: "daniel" });
    expect(st.getSession(tok, 1000 + SESSION_TTL + 1)).toBeNull();
    expect(st.getSession(null, 1001)).toBeNull();
    const tok2 = st.createSession(uid, 1002);
    st.deleteOtherSessions(uid, tok2);
    expect(st.getSession(tok, 1003)).toBeNull();
    expect(st.getSession(tok2, 1003)).not.toBeNull();
    st.deleteSession(tok2);
    expect(st.getSession(tok2, 1004)).toBeNull();
    st.setPassword(uid, "brand-new-password");
    expect(st.verifyLogin("daniel", "correct horse battery")).toBeNull();
    expect(st.verifyLogin("daniel", "brand-new-password")).not.toBeNull();
    expect(st.checkUserPassword(uid, "brand-new-password")).toBe(true);
    expect(st.checkUserPassword(uid, "nope")).toBe(false);
    expect(st.findUser("daniel")).toEqual({ id: uid, username: "daniel" });
    expect(st.findUser("ghost")).toBeNull();
    expect(() => st.deleteUser(uid)).toThrow("last user");
    const uid2 = st.createUser("anna", "another-long-pass", 1000);
    st.deleteUser(uid);
    expect(st.listUsers().map((u) => u.username)).toEqual(["anna"]);
    expect(() => st.deleteUser(uid2)).toThrow("last user");
  });
  it("proxy api keys: mw- secrets, hashed storage, last_used throttle", () => {
    const st = createStore(openDb(":memory:"));
    expect(st.hasApiKeys()).toBe(false);
    const [row, secret] = st.createApiKey("vibe-cli", 1000);
    expect(secret.startsWith("mw-")).toBe(true);
    expect(row.prefix).toBe(secret.slice(0, 7));
    expect(st.hasApiKeys()).toBe(true);
    expect(() => st.createApiKey("vibe-cli", 1000)).toThrow(StoreError);
    expect(() => st.createApiKey("bad name!", 1000)).toThrow(StoreError);
    expect(st.verifyApiKey("nope", 1000)).toBeNull();
    expect(st.verifyApiKey(null, 1000)).toBeNull();
    expect(st.verifyApiKey(secret, 1000)).toEqual({ id: row.id, name: "vibe-cli" });
    expect(must(st.listApiKeys("vibe-cli")[0]).last_used).toBe(1000);
    st.verifyApiKey(secret, 1030);
    expect(must(st.listApiKeys("vibe-cli")[0]).last_used).toBe(1000);
    st.verifyApiKey(secret, 1061);
    expect(must(st.listApiKeys("vibe-cli")[0]).last_used).toBe(1061);
    expect(st.listApiKeys().map((k) => k.name)).toEqual(["vibe-cli"]);
    expect(st.deleteApiKey(row.id)).toBe(true);
    expect(st.verifyApiKey(secret, 1100)).toBeNull();
    expect(st.deleteApiKey(row.id)).toBe(false);
  });
  it("accounts and mistral keys", () => {
    const st = createStore(openDb(":memory:"));
    expect(() => st.createAccount("bad name!")).toThrow(StoreError);
    st.createAccount("one@example.cz", 5, 1000);
    expect(() => st.createAccount("one@example.cz")).toThrow(StoreError);
    st.createAccount("b", 1, 1000);
    expect(st.listAccounts().map((a) => a.name)).toEqual(["b", "one@example.cz"]);
    const acct = must(st.getAccount("one@example.cz"));
    expect(acct.priority).toBe(5);
    expect(acct.enabled).toBe(true);
    expect(() => st.setKey("one@example.cz", "bogus", { value: "good-key-123456" })).toThrow("Unknown pool.");
    expect(() => st.setKey("ghost", "api", { value: "good-key-123456" })).toThrow("Account does not exist.");
    expect(() => st.setKey("one@example.cz", "api", { value: "short" })).toThrow("Key looks invalid.");
    expect(() => st.setKey("one@example.cz", "api", { value: "has space key123" })).toThrow("Key looks invalid.");
    expect(() => st.setKey("one@example.cz", "api", {})).toThrow("Key is missing.");
    st.setKey("one@example.cz", "api", { value: "good-key-123456" });
    const withKey = must(st.getAccount("one@example.cz"));
    const info = st.keyInfo(withKey);
    expect(must(info.api)).toMatchObject({ source: "inline", hint: mask("good-key-123456"), ok: true });
    expect(info.vibe).toBeNull();
    st.setKey("one@example.cz", "vibe", { ref: "env:MW_TEST_MISSING_KEY" });
    const info2 = st.keyInfo(must(st.getAccount("one@example.cz")));
    const vibe = must(info2.vibe);
    expect(vibe.source).toBe("env");
    expect(vibe.ok).toBe(false);
    expect(vibe.error).toContain("MW_TEST_MISSING_KEY");
    st.removeKey("one@example.cz", "vibe");
    expect(st.keyInfo(must(st.getAccount("one@example.cz"))).vibe).toBeNull();
    st.updateAccount("one@example.cz", false, 7);
    const upd = must(st.getAccount("one@example.cz"));
    expect(upd.enabled).toBe(false);
    expect(upd.priority).toBe(7);
    st.deleteAccount("one@example.cz");
    expect(st.getAccount("one@example.cz")).toBeNull();
  });
  it("migrates config.toml accounts and clients once", () => {
    const cfg = defaultConfig();
    cfg.accounts = [{ name: "old", keys: { api: "literal-key-12345" }, priority: 100, enabled: true, manual: {} }];
    cfg.clients = [{ name: "t", token: "tok-1" }];
    const db = openDb(":memory:");
    createStore(db).migrateConfig(cfg);
    const st = createStore(db);
    expect(st.listAccounts().map((a) => a.name)).toEqual(["old"]);
    expect(must(st.verifyApiKey("tok-1")).name).toBe("t");
    st.deleteAccount("old");
    createStore(db).migrateConfig(cfg);
    expect(st.listAccounts()).toEqual([]);
  });
  it("migrateConfig rolls back every write on failure", () => {
    const cfg = defaultConfig();
    cfg.accounts = [
      { name: "good", keys: {}, priority: 100, enabled: true, manual: {} },
      { name: "bad name!", keys: {}, priority: 100, enabled: true, manual: {} },
    ];
    cfg.clients = [{ name: "t", token: "tok-1" }];
    const db = openDb(":memory:");
    expect(() => createStore(db).migrateConfig(cfg)).toThrow(StoreError);
    const st = createStore(db);
    expect(st.listAccounts()).toEqual([]);
    expect(st.listApiKeys()).toEqual([]);
    expect(db.getMeta("config_migrated")).toBeNull();
    cfg.accounts = [{ name: "good", keys: {}, priority: 100, enabled: true, manual: {} }];
    st.migrateConfig(cfg);
    expect(st.listAccounts().map((a) => a.name)).toEqual(["good"]);
    expect(must(st.verifyApiKey("tok-1")).name).toBe("t");
  });
});
