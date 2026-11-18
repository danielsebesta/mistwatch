import { createRequire } from "node:module";

type Napi = typeof import("@napi-rs/keyring");
let loaded: Napi | null | undefined;
// the native module is optional: platforms without a prebuilt binary must still run the app
const native = (): Napi => {
  if (loaded === undefined) {
    try {
      loaded = createRequire(import.meta.url)("@napi-rs/keyring") as Napi;
    } catch {
      loaded = null;
    }
  }
  if (!loaded) throw new Error("the OS keyring is not available on this system");
  return loaded;
};
export type RawCred = { account: string; password: string };
export type CredStore = {
  read: (service: string, target: string) => RawCred | null;
  write: (service: string, target: string, username: string, password: string) => void;
  remove: (service: string, target: string) => void;
};
// Entry(service, user) would address `user.service` targets Python cannot see, so explicit targets are used.
const napiStore: CredStore = {
  read: (service, target) => native().findCredentials(service, target)[0] ?? null,
  write: (service, target, username, password) =>
    native().Entry.withTarget(target, service, username).setPassword(password),
  remove: (service, target) => {
    native().Entry.withTarget(target, service, "").deletePassword();
  },
};
const compound = (user: string, service: string): string => `${user}@${service}`;
export type Keyring = {
  get: (service: string, user: string) => string | null;
  set: (service: string, user: string, password: string) => void;
  drop: (service: string, user: string) => void;
};
// Reproduces Python keyring's WinVaultKeyring (service, username) semantics on
// Windows Credential Manager targets: newest write lives at the bare service
// target, earlier colliding usernames move to `username@service`.
export const createKeyring = (store: CredStore): Keyring => ({
  get: (service, user) => {
    const bare = store.read(service, service);
    if (bare && (!user || bare.account === user)) return bare.password;
    return store.read(service, compound(user, service))?.password ?? null;
  },
  set: (service, user, password) => {
    const bare = store.read(service, service);
    if (bare) store.write(service, compound(bare.account, service), bare.account, bare.password);
    store.write(service, service, user, password);
  },
  drop: (service, user) => {
    for (const target of [service, compound(user, service)]) {
      const c = store.read(service, target);
      if (c && c.account === user) store.remove(service, target);
    }
  },
});
export type AccountStore = {
  read: (service: string, user: string) => RawCred | null;
  write: (service: string, user: string, password: string) => void;
  remove: (service: string, user: string) => void;
};
// macOS/Linux backends ignore `target`, so each (service, user) gets its own entry and the account is re-checked.
export const createAccountKeyring = (store: AccountStore): Keyring => ({
  get: (service, user) => {
    const c = store.read(service, user);
    return c && c.account === user ? c.password : null;
  },
  set: (service, user, password) => store.write(service, user, password),
  drop: (service, user) => {
    const c = store.read(service, user);
    if (c && c.account === user) store.remove(service, user);
  },
});
const napiAccountStore: AccountStore = {
  read: (service, user) => {
    const password = new (native().Entry)(service, user).getPassword();
    return password === null ? null : { account: user, password };
  },
  write: (service, user, password) => new (native().Entry)(service, user).setPassword(password),
  remove: (service, user) => {
    new (native().Entry)(service, user).deletePassword();
  },
};
export const keyring: Keyring =
  process.platform === "win32" ? createKeyring(napiStore) : createAccountKeyring(napiAccountStore);
