import { loadConfig } from "./config.ts";
import type { DB } from "./db.ts";
import { openDb } from "./db.ts";
import { loadLinks } from "./groups.ts";
import type { Store } from "./store.ts";
import { createStore, StoreError, VIBE_REF } from "./store.ts";
import type { Config } from "./types.ts";
export type App = { cfg: Config; db: DB; store: Store };
export const openApp = (): App => {
  const cfg = loadConfig();
  const db = openDb(cfg.db_path);
  const store = createStore(db);
  loadLinks(db);
  store.migrateConfig(cfg);
  cfg.accounts.splice(0, cfg.accounts.length, ...store.listAccounts());
  return { cfg, db, store };
};
export const freeVibeName = (store: Store, base = "vibe-login"): string => {
  let name = base;
  for (let i = 2; store.getAccount(name); i++) name = `${base}-${i}`;
  return name;
};
export const linkVibeLogin = (store: Store, name: string): void => {
  const acct = store.getAccount(name);
  if (acct?.keys.vibe !== undefined && acct.keys.vibe !== VIBE_REF)
    throw new StoreError(`Account '${name}' already has its own Vibe key; pick another name with --name.`);
  if (!acct) store.createAccount(name);
  store.setKey(name, "vibe", { ref: VIBE_REF });
};
