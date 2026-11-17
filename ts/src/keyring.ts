import { Entry, findCredentials } from "@napi-rs/keyring";
export type RawCred = { account: string; password: string };
export type CredStore = {
  read: (service: string, target: string) => RawCred | null;
  write: (service: string, target: string, username: string, password: string) => void;
  remove: (service: string, target: string) => void;
};
// Entry(service, user) would address `user.service` targets Python cannot see, so explicit targets are used.
const napiStore: CredStore = {
  read: (service, target) => findCredentials(service, target)[0] ?? null,
  write: (service, target, username, password) => Entry.withTarget(target, service, username).setPassword(password),
  remove: (service, target) => {
    Entry.withTarget(target, service, "").deletePassword();
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
export const keyring: Keyring = createKeyring(napiStore);
