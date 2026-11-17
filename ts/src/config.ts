import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { type Keyring, keyring } from "./keyring.ts";
import type { Account, Client, Config, Limits, ManualPool, PriceOverride, RouterCfg } from "./types.ts";
export const homeDir = (): string => process.env.MISTWATCH_HOME || join(homedir(), ".mistwatch");
export const configPath = (): string => process.env.MISTWATCH_CONFIG || join(homeDir(), "config.toml");
export const defaultLimits = (): Limits => ({
  reserve_pct: 3.0,
  burst_5h: 2.0,
  burst_day: 1.5,
  burst_week: 1.25,
  sync_interval_s: 300,
  strategy: "most_headroom",
  fallback_to_other_pool: true,
  vibe_user_agent_regex: "Mistral-Vibe",
});
const defaultRouterCfg = (): RouterCfg => ({
  llm_classifier: true,
  classifier_model: "ministral-3b-latest",
  classifier_timeout_s: 2.0,
});
export const defaultConfig = (): Config => ({
  host: "127.0.0.1",
  port: 8787,
  upstream: "https://api.mistral.ai",
  usd_to_eur: 0.86,
  db_path: join(homeDir(), "mistwatch.db"),
  limits: defaultLimits(),
  router: defaultRouterCfg(),
  accounts: [],
  clients: [],
  price_overrides: {},
});
type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const describe = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
const pyBool = (v: unknown): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" || typeof v === "bigint") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isTable(v)) return Object.keys(v).length > 0;
  return false;
};
const pyInt = (v: unknown): number => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  throw new TypeError(`int() argument must be a string or a number, not ${describe(v)}`);
};
const pyFloat = (v: unknown): number => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (!Number.isNaN(n)) return n;
  }
  throw new TypeError(`float() argument must be a string or a number, not ${describe(v)}`);
};
const pyStr = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  throw new TypeError(`str() argument must be a primitive, not ${describe(v)}`);
};
const pick = <T>(src: Table, key: string, def: T, coerce: (v: unknown) => T): T =>
  key in src ? coerce(src[key]) : def;
const reqTable = (v: unknown, what: string): Table => {
  if (!isTable(v)) throw new TypeError(`${what} must be a table, not ${describe(v)}`);
  return v;
};
const optTable = (v: unknown, what: string): Table => (v === undefined ? {} : reqTable(v, what));
const reqArray = (v: unknown, what: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new TypeError(`${what} must be an array, not ${describe(v)}`);
  return v;
};
const parseKeys = (v: unknown): Record<string, string> => {
  return Object.fromEntries(Object.entries(optTable(v, "account.keys")).map(([k, x]) => [k, pyStr(x)]));
};
const parseManual = (v: unknown): Record<string, ManualPool> => {
  return Object.fromEntries(
    Object.entries(optTable(v, "account.manual")).map(([pool, mv]) => [
      pool,
      Object.fromEntries(
        Object.entries(reqTable(mv, "account.manual entry")).map(([k, x]): [string, string | number | boolean] => {
          if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return [k, x];
          if (typeof x === "bigint") return [k, Number(x)];
          throw new TypeError(`account.manual.${pool}.${k} must be a primitive, not ${describe(x)}`);
        }),
      ),
    ]),
  );
};
const parseOverrides = (v: unknown): Record<string, PriceOverride> => {
  return Object.fromEntries(
    Object.entries(optTable(v, "pricing.models")).map(([model, p]) => {
      const t = reqTable(p, `price override for ${model}`);
      return [
        model,
        {
          input: pyFloat(t.input),
          output: pyFloat(t.output),
          cached: t.cached === undefined ? undefined : pyFloat(t.cached),
        },
      ];
    }),
  );
};
export const loadConfig = (path?: string): Config => {
  const p = path ?? configPath();
  if (!existsSync(p)) throw new Error(`${p} not found - run \`mistwatch init\` first`);
  const raw = parse(readFileSync(p, "utf8"));
  const cfg = defaultConfig();
  const server = optTable(raw.server, "server");
  cfg.host = pick(server, "host", cfg.host, pyStr);
  cfg.port = pick(server, "port", cfg.port, pyInt);
  cfg.upstream = pick(optTable(raw.upstream, "upstream"), "base_url", cfg.upstream, pyStr).replace(/\/+$/, "");
  const pricing = optTable(raw.pricing, "pricing");
  cfg.usd_to_eur = pick(pricing, "usd_to_eur", cfg.usd_to_eur, pyFloat);
  cfg.price_overrides = parseOverrides(pricing.models);
  const storage = optTable(raw.storage, "storage");
  if ("db_path" in storage) cfg.db_path = pyStr(storage.db_path);
  const lim = optTable(raw.limits, "limits");
  cfg.limits = {
    reserve_pct: pick(lim, "reserve_pct", cfg.limits.reserve_pct, pyFloat),
    burst_5h: pick(lim, "burst_5h", cfg.limits.burst_5h, pyFloat),
    burst_day: pick(lim, "burst_day", cfg.limits.burst_day, pyFloat),
    burst_week: pick(lim, "burst_week", cfg.limits.burst_week, pyFloat),
    sync_interval_s: pick(lim, "sync_interval_s", cfg.limits.sync_interval_s, pyInt),
    strategy: pick(lim, "strategy", cfg.limits.strategy, pyStr),
    fallback_to_other_pool: pick(lim, "fallback_to_other_pool", cfg.limits.fallback_to_other_pool, pyBool),
    vibe_user_agent_regex: pick(lim, "vibe_user_agent_regex", cfg.limits.vibe_user_agent_regex, pyStr),
  };
  const rou = optTable(raw.router, "router");
  cfg.router = {
    llm_classifier: pick(rou, "llm_classifier", cfg.router.llm_classifier, pyBool),
    classifier_model: pick(rou, "classifier_model", cfg.router.classifier_model, pyStr),
    classifier_timeout_s: pick(rou, "classifier_timeout_s", cfg.router.classifier_timeout_s, pyFloat),
  };
  for (const a of reqArray(raw.accounts, "accounts")) {
    const t = reqTable(a, "account entry");
    cfg.accounts.push({
      name: pyStr(t.name),
      keys: parseKeys(t.keys),
      priority: t.priority === undefined ? 100 : pyInt(t.priority),
      enabled: t.enabled === undefined ? true : pyBool(t.enabled),
      manual: parseManual(t.manual),
    });
  }
  for (const c of reqArray(raw.clients, "clients")) {
    const t = reqTable(c, "client entry");
    cfg.clients.push({ name: pyStr(t.name), token: pyStr(t.token) } satisfies Client);
  }
  return cfg;
};
export const resolveSecret = (ref: string, kr: Keyring = keyring): string => {
  if (ref.startsWith("env:")) {
    const v = process.env[ref.slice(4)];
    if (!v) throw new Error(`environment variable ${ref.slice(4)} is not set`);
    return v;
  }
  if (ref.startsWith("keyring:")) {
    const rest = ref.slice(8);
    const i = rest.indexOf("/");
    const service = i < 0 ? rest : rest.slice(0, i);
    const user = i < 0 ? "" : rest.slice(i + 1);
    const v = kr.get(service, user);
    if (!v) throw new Error(`no keyring entry ${service}/${user}`);
    return v;
  }
  return ref;
};
export const keyFor = (a: Account, pool: string): string | null => {
  const ref = a.keys[pool];
  return ref ? resolveSecret(ref) : null;
};
export const anyKey = (a: Account): string => {
  for (const ref of Object.values(a.keys)) return resolveSecret(ref);
  throw new Error(`account ${a.name} has no keys configured`);
};
