import { keyFor, resolveSecret } from "./config.ts";
import { fetchOwner, type KeyOwner } from "./owner.ts";
import type { State } from "./state.ts";
import { StoreError, VIBE_REF } from "./store.ts";
import { checkKey } from "./sync.ts";
import { POOLS } from "./types.ts";

type Pool = (typeof POOLS)[number];

// Accounts are not named by hand: a key says who it belongs to, and keys of the same person end up together.
const clean = (s: string): string =>
  s
    .trim()
    .replace(/[^A-Za-z0-9._+@-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
export const accountNameFor = (o: KeyOwner | null, key: string): string => {
  const base = clean(o?.email ?? o?.organization ?? o?.workspace ?? o?.name ?? "");
  return base.length >= 1 ? base : `key-${key.slice(-4).replace(/[^A-Za-z0-9]/g, "x")}`;
};
const poolOf = (o: KeyOwner | null, budgets: Partial<Record<Pool, unknown>>): Pool => {
  if (o?.kind === "chat") return "vibe";
  if (o?.kind === "api") return "api";
  const have = POOLS.filter((p) => budgets[p] !== undefined);
  return have.length === 1 ? (have[0] ?? "api") : "api";
};
export type Adopted = { account: string; pool: Pool; created: boolean };

// Puts one key where it belongs: the account of the same owner (named after their e-mail or organization), the
// pool the key is for. Returns where it went.
export const adoptKey = async (
  st: State,
  secret: { value: string } | { ref: string },
  from?: { account: string; pool: string },
): Promise<Adopted> => {
  const ref = "ref" in secret ? secret.ref : null;
  const key = "value" in secret ? secret.value.trim() : resolveSecret(secret.ref);
  const chk = await checkKey(st.fetch, st.cfg.upstream, key);
  if (!chk.valid) throw new StoreError(chk.error ?? "Mistral rejected the key.");
  const owner = await fetchOwner(st.fetch, st.cfg.upstream, st.cfg.console_upstream, key, true);
  const pool = poolOf(owner, chk.budgets ?? {});
  const accounts = st.store.listAccounts();
  const same = accounts.find((a) =>
    POOLS.some((p) => {
      if (from && a.name === from.account && p === from.pool) return false;
      try {
        return keyFor(a, p) === key;
      } catch {
        return false;
      }
    }),
  );
  let created = false;
  let name = same?.name ?? accountNameFor(owner, key);
  if (!st.store.getAccount(name)) {
    st.store.createAccount(name);
    created = true;
  }
  const target = same ? (POOLS.find((p) => keyFor(same, p) === key) ?? pool) : pool;
  if (ref === VIBE_REF) st.store.setKey(name, target, { ref: VIBE_REF });
  else if (!same) st.store.setKey(name, target, { value: key });
  name = st.store.getAccount(name)?.name ?? name;
  return { account: name, pool: target, created };
};

// Every key of an account moves to the account it belongs to; an account left empty is removed.
export const adoptAccount = async (st: State, source: string): Promise<Adopted[]> => {
  const a = st.store.getAccount(source);
  if (!a) throw new StoreError("Account does not exist.");
  const out: Adopted[] = [];
  for (const pool of POOLS) {
    const raw = a.keys[pool];
    if (!raw) continue;
    const secret = raw === VIBE_REF ? { ref: raw } : { value: resolveSecret(raw) };
    const moved = await adoptKey(st, secret, { account: source, pool });
    out.push(moved);
    if (moved.account !== source) st.store.removeKey(source, pool);
  }
  const kept = out.some((o) => o.account === source);
  if (!kept) st.store.deleteAccount(source);
  return out;
};
