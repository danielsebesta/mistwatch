import { existsSync, readFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { type Keyring, keyring } from "./keyring.ts";
import type { Account, Client, Config, Limits, ManualPool, PriceOverride, RouterCfg } from "./types.ts";

declare const __USD_TO_EUR__: number | undefined;
export const DEFAULT_USD_TO_EUR = typeof __USD_TO_EUR__ === "number" ? __USD_TO_EUR__ : 0.86;
export const clientBaseUrl = (cfg: { host: string; port: number }, path = ""): string => {
  const h = cfg.host === "0.0.0.0" || cfg.host === "::" || cfg.host === "" ? "127.0.0.1" : cfg.host;
  return `http://${isIPv6(h) ? `[${h}]` : h}:${cfg.port}${path}`;
};
export const homeDir = (): string => process.env.MISTWATCH_HOME || join(homedir(), ".mistwatch");
export const configPath = (): string => process.env.MISTWATCH_CONFIG || join(homeDir(), "config.toml");
export const CONFIG_TEMPLATE = `# mistwatch config (server, limits, pricing). Accounts, keys and logins are managed in the web UI.
[server]
host = "127.0.0.1"
port = 8787
# Extra host names allowed to reach the UI and API, for example a tunnel: allowed_hosts = ["mw.example.com"]
# Set to true only behind a reverse proxy (Caddy, nginx, Cloudflare) that sets X-Forwarded-For and X-Forwarded-Proto.
# Then per-IP limits use the real client address and cookies get the Secure flag.
trust_proxy = false
# Largest request body the proxy accepts, in MiB. Raise it for clients that send images or very long contexts.
max_body_mb = 32

[upstream]
base_url = "https://api.mistral.ai"
# Where the Vibe CLI reads your plan and name (served at /api/vibe/whoami and /users/me when its console_base_url points here)
console_url = "https://console.mistral.ai"

[pricing]
usd_to_eur = ${DEFAULT_USD_TO_EUR}          # docs prices are USD, budgets are EUR

[limits]
reserve_pct = 3.0          # untouchable slice of every pool's monthly budget
burst_5h = 2.0             # x fair pace allowed within any 5h window
burst_day = 1.5
burst_week = 1.25
sync_interval_s = 300
strategy = "most_headroom" # or "priority"
fallback_to_other_pool = true
vibe_user_agent_regex = "Mistral-Vibe"

[router]
llm_classifier = true      # ask a tiny model to rate prompt difficulty for \`auto\`
classifier_model = "ministral-3b-latest"
`;
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
  allowed_hosts: [],
  trust_proxy: false,
  max_body_mb: 32,
  upstream: "https://api.mistral.ai",
  console_upstream: "https://console.mistral.ai",
  usd_to_eur: DEFAULT_USD_TO_EUR,
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
const asBool = (v: unknown): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" || typeof v === "bigint") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isTable(v)) return Object.keys(v).length > 0;
  return false;
};
const asInt = (v: unknown): number => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  throw new TypeError(`int() argument must be a string or a number, not ${describe(v)}`);
};
const finiteInt = (v: unknown): number => {
  if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError(`cannot convert ${v} to int`);
  return asInt(v);
};
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?infinity$/i;
const asFloat = (v: unknown): number => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const t = v.trim();
    const n = Number(t);
    if (FLOAT_RE.test(t) && !Number.isNaN(n)) return n;
  }
  throw new TypeError(`float() argument must be a string or a number, not ${describe(v)}`);
};
const asStr = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  throw new TypeError(`str() argument must be a primitive, not ${describe(v)}`);
};
const hostList = (v: unknown): string[] => {
  if (!Array.isArray(v)) throw new TypeError(`allowed_hosts must be a list of host names, not ${describe(v)}`);
  return v
    .map((h) => asStr(h).trim().toLowerCase().replace(/\.$/, ""))
    .filter((h) => h !== "")
    .map((h) => {
      const bare = h.replace(/^\[|\]$/g, "");
      if (isIPv6(bare)) return bare;
      if (/[:/[\]\s]/.test(h))
        throw new TypeError(
          `allowed_hosts entries are bare host names without port, scheme or path, not ${JSON.stringify(h)}`,
        );
      return h;
    });
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
  return Object.fromEntries(Object.entries(optTable(v, "account.keys")).map(([k, x]) => [k, asStr(x)]));
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
          input: asFloat(t.input),
          output: asFloat(t.output),
          cached: t.cached === undefined ? undefined : asFloat(t.cached),
        },
      ];
    }),
  );
};
export const loadConfig = (path?: string): Config => {
  const p = path ?? configPath();
  if (!existsSync(p)) throw new Error(`${p} not found - run \`mistwatch init\` first`);
  let raw: Record<string, unknown>;
  try {
    raw = parse(readFileSync(p, "utf8"));
  } catch (e) {
    // the library message quotes source lines, which can hold keys and tokens
    const at = e instanceof TomlError ? ` at line ${e.line}, column ${e.column}` : "";
    throw new Error(`${p}: invalid TOML${at}`);
  }
  const cfg = defaultConfig();
  const server = optTable(raw.server, "server");
  // MISTWATCH_HOST exists for the Docker image, where the server must listen on 0.0.0.0
  cfg.host = process.env.MISTWATCH_HOST || pick(server, "host", cfg.host, asStr);
  cfg.port = pick(server, "port", cfg.port, asInt);
  cfg.trust_proxy = pick(server, "trust_proxy", cfg.trust_proxy, asBool);
  if (process.env.MISTWATCH_TRUST_PROXY) cfg.trust_proxy = /^(1|true|yes|on)$/i.test(process.env.MISTWATCH_TRUST_PROXY);
  cfg.max_body_mb = pick(server, "max_body_mb", cfg.max_body_mb, finiteInt);
  if (cfg.max_body_mb < 1) throw new TypeError(`max_body_mb must be at least 1, not ${cfg.max_body_mb}`);
  cfg.allowed_hosts = pick(server, "allowed_hosts", cfg.allowed_hosts, hostList);
  // MISTWATCH_ALLOWED_HOSTS (comma separated) adds to the file list, so Docker needs no config edit
  const envHosts = process.env.MISTWATCH_ALLOWED_HOSTS;
  if (envHosts) cfg.allowed_hosts = [...new Set([...cfg.allowed_hosts, ...hostList(envHosts.split(","))])];
  cfg.upstream = pick(optTable(raw.upstream, "upstream"), "base_url", cfg.upstream, asStr).replace(/\/+$/, "");
  cfg.console_upstream = pick(optTable(raw.upstream, "upstream"), "console_url", cfg.console_upstream, asStr).replace(
    /\/+$/,
    "",
  );
  const pricing = optTable(raw.pricing, "pricing");
  cfg.usd_to_eur = pick(pricing, "usd_to_eur", cfg.usd_to_eur, asFloat);
  cfg.price_overrides = parseOverrides(pricing.models);
  const storage = optTable(raw.storage, "storage");
  if ("db_path" in storage) cfg.db_path = asStr(storage.db_path);
  const lim = optTable(raw.limits, "limits");
  cfg.limits = {
    reserve_pct: pick(lim, "reserve_pct", cfg.limits.reserve_pct, asFloat),
    burst_5h: pick(lim, "burst_5h", cfg.limits.burst_5h, asFloat),
    burst_day: pick(lim, "burst_day", cfg.limits.burst_day, asFloat),
    burst_week: pick(lim, "burst_week", cfg.limits.burst_week, asFloat),
    sync_interval_s: pick(lim, "sync_interval_s", cfg.limits.sync_interval_s, finiteInt),
    strategy: pick(lim, "strategy", cfg.limits.strategy, asStr),
    fallback_to_other_pool: pick(lim, "fallback_to_other_pool", cfg.limits.fallback_to_other_pool, asBool),
    vibe_user_agent_regex: pick(lim, "vibe_user_agent_regex", cfg.limits.vibe_user_agent_regex, asStr),
  };
  const rou = optTable(raw.router, "router");
  cfg.router = {
    llm_classifier: pick(rou, "llm_classifier", cfg.router.llm_classifier, asBool),
    classifier_model: pick(rou, "classifier_model", cfg.router.classifier_model, asStr),
    classifier_timeout_s: pick(rou, "classifier_timeout_s", cfg.router.classifier_timeout_s, asFloat),
  };
  for (const a of reqArray(raw.accounts, "accounts")) {
    const t = reqTable(a, "account entry");
    cfg.accounts.push({
      name: asStr(t.name),
      keys: parseKeys(t.keys),
      priority: t.priority === undefined ? 100 : asInt(t.priority),
      enabled: t.enabled === undefined ? true : asBool(t.enabled),
      manual: parseManual(t.manual),
    });
  }
  for (const c of reqArray(raw.clients, "clients")) {
    const t = reqTable(c, "client entry");
    cfg.clients.push({ name: asStr(t.name), token: asStr(t.token) } satisfies Client);
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
