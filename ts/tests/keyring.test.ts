import { beforeEach, describe, expect, it } from "vitest";
import { resolveSecret } from "../src/config.ts";
import { type CredStore, createKeyring, type RawCred } from "../src/keyring.ts";
import { dropSecret, KEYRING_SERVICE, saveSecret, vibeCliKeyPresent } from "../src/store.ts";

const fakeVault = (): { store: CredStore; creds: Map<string, RawCred> } => {
  const creds = new Map<string, RawCred>();
  const store: CredStore = {
    read: (_service, target) => creds.get(target) ?? null,
    write: (_service, target, username, password) => {
      creds.set(target, { account: username, password });
    },
    remove: (_service, target) => {
      creds.delete(target);
    },
  };
  return { store, creds };
};
beforeEach(() => {
  delete process.env.MISTWATCH_NO_KEYRING;
});
describe("windows credential layout parity with python WinVaultKeyring", () => {
  it("writes the newest password at the bare service target", () => {
    const { store, creds } = fakeVault();
    const kr = createKeyring(store);
    kr.set("svc", "u1", "p1");
    expect([...creds.entries()]).toEqual([["svc", { account: "u1", password: "p1" }]]);
    kr.set("svc", "u2", "p2");
    expect(creds.get("svc")).toEqual({ account: "u2", password: "p2" });
    expect(creds.get("u1@svc")).toEqual({ account: "u1", password: "p1" });
  });
  it("reads both targets the way python resolves them", () => {
    const { store } = fakeVault();
    store.write("svc", "svc", "new", "p-new");
    store.write("svc", "old@svc", "old", "p-old");
    const kr = createKeyring(store);
    expect(kr.get("svc", "new")).toBe("p-new");
    expect(kr.get("svc", "old")).toBe("p-old");
    expect(kr.get("svc", "")).toBe("p-new");
    expect(kr.get("svc", "ghost")).toBeNull();
    expect(kr.get("gone", "u")).toBeNull();
  });
  it("prefers the bare target over a stale compound entry", () => {
    const { store } = fakeVault();
    store.write("svc", "svc", "u1", "fresh");
    store.write("svc", "u1@svc", "u1", "stale");
    expect(createKeyring(store).get("svc", "u1")).toBe("fresh");
  });
  it("deletes only the matching user's entries on both targets", () => {
    const { store, creds } = fakeVault();
    const kr = createKeyring(store);
    kr.set("svc", "u1", "p1");
    kr.set("svc", "u2", "p2");
    kr.drop("svc", "u2");
    expect(creds.has("svc")).toBe(false);
    expect(creds.get("u1@svc")).toEqual({ account: "u1", password: "p1" });
    kr.drop("svc", "u1");
    expect(creds.size).toBe(0);
    kr.drop("svc", "ghost");
  });
  it("round-trips credentials so python can read what ts saved", () => {
    const { store, creds } = fakeVault();
    const kr = createKeyring(store);
    kr.set("mistwatch", "acct@x.cz/api", "k-1");
    // python get: read bare target, UserName must match -> falls to compound
    const pyRead = (service: string, user: string): string | null => {
      const bare = creds.get(service);
      if (bare && (!user || bare.account === user)) return bare.password;
      return creds.get(`${user}@${service}`)?.password ?? null;
    };
    expect(pyRead("mistwatch", "acct@x.cz/api")).toBe("k-1");
  });
});
describe("secret refs over the keyring", () => {
  it("saveSecret returns a keyring ref resolvable via resolveSecret", () => {
    const { store, creds } = fakeVault();
    const kr = createKeyring(store);
    const ref = saveSecret("acct@x.cz", "api", "real-key-123", kr);
    expect(ref).toBe(`keyring:${KEYRING_SERVICE}/acct@x.cz/api`);
    expect(creds.get(KEYRING_SERVICE)).toEqual({ account: "acct@x.cz/api", password: "real-key-123" });
    expect(resolveSecret(ref, kr)).toBe("real-key-123");
  });
  it("saveSecret falls back to inline when the keyring misbehaves", () => {
    const broken: CredStore = {
      read: () => null,
      write: () => {
        throw new Error("no keyring");
      },
      remove: () => undefined,
    };
    expect(saveSecret("a", "api", "inline-key-123", createKeyring(broken))).toBe("inline-key-123");
    const misread: CredStore = {
      read: () => ({ account: "a/api", password: "different" }),
      write: () => undefined,
      remove: () => undefined,
    };
    expect(saveSecret("a", "api", "inline-key-123", createKeyring(misread))).toBe("inline-key-123");
  });
  it("honours MISTWATCH_NO_KEYRING", () => {
    process.env.MISTWATCH_NO_KEYRING = "1";
    try {
      expect(saveSecret("a", "api", "plain-key-123", createKeyring(fakeVault().store))).toBe("plain-key-123");
    } finally {
      delete process.env.MISTWATCH_NO_KEYRING;
    }
  });
  it("dropSecret deletes the referenced entry and ignores foreign refs", () => {
    const { store, creds } = fakeVault();
    const kr = createKeyring(store);
    saveSecret("a", "vibe", "vibe-key-12345", kr);
    dropSecret(`keyring:${KEYRING_SERVICE}/a/vibe`, kr);
    expect(creds.size).toBe(0);
    dropSecret("keyring:other/a/vibe", kr);
    dropSecret("literal-value", kr);
  });
  it("vibeCliKeyPresent probes the vibe cli credential", () => {
    const { store } = fakeVault();
    const kr = createKeyring(store);
    expect(vibeCliKeyPresent(kr)).toBe(false);
    store.write("ai.mistral.vibe", "ai.mistral.vibe", "MISTRAL_API_KEY", "vibe-key");
    expect(vibeCliKeyPresent(kr)).toBe(true);
    const broken: CredStore = {
      read: () => {
        throw new Error("locked");
      },
      write: () => undefined,
      remove: () => undefined,
    };
    expect(vibeCliKeyPresent(createKeyring(broken))).toBe(false);
  });
});
