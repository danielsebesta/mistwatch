import { loadConfig } from "./config.ts";
import type { DB } from "./db.ts";
import { openDb } from "./db.ts";
import type { Store } from "./store.ts";
import { createStore, VIBE_REF } from "./store.ts";
import type { Config } from "./types.ts";
export type App = { cfg: Config; db: DB; store: Store };
export const openApp = (): App => {
  const cfg = loadConfig();
  const db = openDb(cfg.db_path);
  const store = createStore(db);
  store.migrateConfig(cfg);
  cfg.accounts.splice(0, cfg.accounts.length, ...store.listAccounts());
  return { cfg, db, store };
};
export const linkVibeLogin = (store: Store, name: string): void => {
  if (!store.getAccount(name)) store.createAccount(name);
  store.setKey(name, "vibe", { ref: VIBE_REF });
};
