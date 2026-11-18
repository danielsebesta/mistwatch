import { expect } from "vitest";
import type { DB } from "../src/db.ts";
import type { Account } from "../src/types.ts";
export const NOW = 1_800_000_000;
export const RESET = NOW + 15 * 86400;
export const must = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("unexpected nullish value");
  return v;
};
export const snap = (db: DB, account: string, pool: string, used: number, initial: number, ts = NOW): void =>
  db.addSnapshot({ ts, account, pool, used_eur: used, initial_eur: initial, reset_at: RESET, currency: "EUR" });
export const seed = (db: DB, account: string, vibeUsed = 0, apiUsed = 0, vibe = 127.5, api = 12.75, ts = NOW): void => {
  snap(db, account, "vibe", vibeUsed, vibe, ts);
  snap(db, account, "api", apiUsed, api, ts);
};
export const accounts = (...names: string[]): Account[] =>
  names.map((name, i) => ({ name, keys: { vibe: "k" }, priority: i, enabled: true, manual: {} }));
export const close = (v: number, expected: number, tol = 1e-9): void => {
  expect(Math.abs(v - expected), `${v} ≈ ${expected}`).toBeLessThanOrEqual(tol);
};
