import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { startServer } from "../src/app.ts";
import { defaultConfig } from "../src/config.ts";
import { type DB, openDb } from "../src/db.ts";
import { createPriceBook, type PriceBook } from "../src/pricing.ts";
import { createStore } from "../src/store.ts";
import { nextReset } from "../src/sync.ts";
import type { Config } from "../src/types.ts";

type Pool = "vibe" | "api";
type Person = {
  first: string;
  last: string;
  email: string;
  workspace: string;
  org: string | null;
  plan: string;
  planType: string;
};
type ModelSpec = {
  id: string;
  weight: number;
  endpoint: string;
  prompt: [number, number];
  completion: [number, number];
  cached: [number, number];
  latency: [number, number];
};
type BudgetSpec = {
  id: string;
  pool: Pool;
  initial: number;
  target: number;
  accounts: string[];
  weight: number;
};
type Row = {
  ts: number;
  account: string;
  pool: Pool;
  client: string;
  model: string;
  endpoint: string;
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
  status: number;
  latency: number;
};
type Budget = { pool: Pool; initial: number; used: number; resetAt: number };
type DemoData = {
  keyToAccount: Map<string, string>;
  accountPerson: Map<string, Person>;
  accountBudgets: Map<string, Budget[]>;
};

const DANIEL: Person = {
  first: "Daniel",
  last: "Šebesta",
  email: "daniel@sebesta.dev",
  workspace: "Personal",
  org: null,
  plan: "PRO",
  planType: "individual",
};
const TEREZA: Person = {
  first: "Tereza",
  last: "Nováková",
  email: "tereza@northwind.studio",
  workspace: "Northwind Studio",
  org: "Northwind Studio",
  plan: "TEAM",
  planType: "team",
};
const JAKUB: Person = {
  first: "Jakub",
  last: "Dvořák",
  email: "jakub@northwind.studio",
  workspace: "Northwind Studio",
  org: "Northwind Studio",
  plan: "TEAM",
  planType: "team",
};
const ACCOUNTS = [
  { name: DANIEL.email, priority: 10, person: DANIEL },
  { name: TEREZA.email, priority: 20, person: TEREZA },
  { name: JAKUB.email, priority: 30, person: JAKUB },
];
// Tereza and Jakub use two Studio keys of one workspace, so they share a single API budget.
const BUDGETS: BudgetSpec[] = [
  { id: "daniel-vibe", pool: "vibe", initial: 127.5, target: 70.0, accounts: [DANIEL.email], weight: 55 },
  { id: "daniel-api", pool: "api", initial: 127.5, target: 79.0, accounts: [DANIEL.email], weight: 15 },
  { id: "northwind-api", pool: "api", initial: 255.0, target: 96.0, accounts: [TEREZA.email, JAKUB.email], weight: 30 },
];
const VIBE_MODELS: ModelSpec[] = [
  {
    id: "mistral-vibe-cli-latest",
    weight: 52,
    endpoint: "/v1/chat/completions",
    prompt: [3000, 48000],
    completion: [250, 2800],
    cached: [0.05, 0.55],
    latency: [600, 9000],
  },
  {
    id: "mistral-vibe-cli-fast",
    weight: 26,
    endpoint: "/v1/chat/completions",
    prompt: [1500, 22000],
    completion: [120, 1200],
    cached: [0.05, 0.5],
    latency: [300, 3500],
  },
  {
    id: "zai-glm-5-3-flash",
    weight: 14,
    endpoint: "/v1/chat/completions",
    prompt: [4000, 60000],
    completion: [200, 2200],
    cached: [0.1, 0.6],
    latency: [500, 6000],
  },
  {
    id: "mistral-large-latest",
    weight: 8,
    endpoint: "/v1/chat/completions",
    prompt: [3000, 30000],
    completion: [300, 2500],
    cached: [0.05, 0.4],
    latency: [800, 12000],
  },
];
const API_MODELS: ModelSpec[] = [
  {
    id: "mistral-large-latest",
    weight: 24,
    endpoint: "/v1/chat/completions",
    prompt: [5000, 90000],
    completion: [300, 4000],
    cached: [0.05, 0.5],
    latency: [900, 14000],
  },
  {
    id: "mistral-small-latest",
    weight: 22,
    endpoint: "/v1/chat/completions",
    prompt: [2000, 40000],
    completion: [150, 2000],
    cached: [0.05, 0.5],
    latency: [300, 4000],
  },
  {
    id: "codestral-latest",
    weight: 18,
    endpoint: "/v1/fim/completions",
    prompt: [800, 12000],
    completion: [40, 700],
    cached: [0, 0.2],
    latency: [200, 2500],
  },
  {
    id: "ministral-3-14b-latest",
    weight: 12,
    endpoint: "/v1/chat/completions",
    prompt: [1000, 20000],
    completion: [100, 1200],
    cached: [0.05, 0.4],
    latency: [250, 3000],
  },
  {
    id: "zai-glm-5-3",
    weight: 8,
    endpoint: "/v1/chat/completions",
    prompt: [6000, 80000],
    completion: [400, 5000],
    cached: [0.1, 0.6],
    latency: [1000, 16000],
  },
  {
    id: "mistral-embed",
    weight: 16,
    endpoint: "/v1/embeddings",
    prompt: [200, 8000],
    completion: [0, 0],
    cached: [0, 0],
    latency: [80, 600],
  },
];
const VIBE_CLIENTS = [
  { name: "vibe-cli", weight: 82 },
  { name: "opencode", weight: 12 },
  { name: "pi", weight: 6 },
];
const API_CLIENTS = [
  { name: "opencode", weight: 28 },
  { name: "pi", weight: 16 },
  { name: "notebook", weight: 24 },
  { name: "scripts", weight: 32 },
];
// People work in the morning and afternoon, with a smaller evening tail.
const HOUR_WEIGHTS = [
  0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 4.0, 3.6, 2.4, 3.0, 4.2, 4.0, 3.4, 2.8, 2.0, 1.6, 1.8, 1.4, 0.9,
  0.5,
];
const MODELS = [
  {
    id: "mistral-large-latest",
    name: "Mistral Large 4",
    aliases: ["mistral-large-4-0"],
    description: "Flagship model for reasoning, coding and long context.",
  },
  {
    id: "mistral-small-latest",
    name: "Mistral Small 4",
    aliases: ["mistral-small-2603"],
    description: "Fast and cheap general-purpose model.",
  },
  {
    id: "mistral-vibe-cli-latest",
    name: "Mistral Medium 3.5",
    aliases: [],
    description: "Default model of the Vibe coding agent.",
  },
  {
    id: "mistral-vibe-cli-fast",
    name: "Mistral Small 4",
    aliases: [],
    description: "Fast variant used for small edits.",
  },
  {
    id: "codestral-latest",
    name: "Codestral",
    aliases: ["codestral-2508"],
    description: "Code completion and fill-in-the-middle.",
  },
  {
    id: "ministral-3-14b-latest",
    name: "Ministral 3 14B",
    aliases: ["ministral-3-14b-2512"],
    description: "Small model for local and edge work.",
  },
  { id: "zai-glm-5-3", name: "GLM 5.3", aliases: [], description: "Long-context reasoning model." },
  { id: "zai-glm-5-3-flash", name: "GLM 5.3 Flash", aliases: [], description: "Cheap long-context model." },
  { id: "mistral-embed", name: "Mistral Embed", aliases: [], description: "Text embeddings." },
  {
    id: "deepseek-v4-1-flash-1017",
    name: "DeepSeek V4.1 Flash",
    aliases: [],
    description: "Fast reasoning model.",
  },
];
const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HELP = `mistwatch demo - a throwaway instance with made-up usage

Usage: npm run demo -- [options]

  --port N           web UI port (default 8788)
  --upstream-port N  fake Mistral port (default 8790)
  --seed TEXT        data seed, or "random" (default mistwatch)
  -h, --help         show this help

Sign in as daniel / mistwatch-demo. The data lives in .demo/ and is regenerated on every run.
`;

const hashSeed = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const mulberry32 = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const between = (rnd: () => number, a: number, b: number): number => a + rnd() * (b - a);
const logBetween = (rnd: () => number, a: number, b: number): number =>
  Math.exp(between(rnd, Math.log(a), Math.log(b)));
const pick = <T>(rnd: () => number, xs: readonly T[]): T => {
  const x = xs[Math.floor(rnd() * xs.length)];
  if (x === undefined) throw new Error("pick from an empty list");
  return x;
};
const weighted = <T extends { weight: number }>(rnd: () => number, xs: readonly T[]): T => {
  const total = xs.reduce((s, x) => s + x.weight, 0);
  let r = rnd() * total;
  for (const x of xs) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  const last = xs[xs.length - 1];
  if (!last) throw new Error("weighted pick from an empty list");
  return last;
};
const pickHour = (rnd: () => number): number => {
  const total = HOUR_WEIGHTS.reduce((s, w) => s + w, 0);
  let r = rnd() * total;
  for (let i = 0; i < HOUR_WEIGHTS.length; i++) {
    r -= HOUR_WEIGHTS[i] ?? 0;
    if (r <= 0) return i;
  }
  return 23;
};
const startOfDay = (ts: number): number => {
  const d = new Date(ts * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
};
const makeKey = (rnd: () => number): string =>
  Array.from({ length: 32 }, () => KEY_ALPHABET[Math.floor(rnd() * KEY_ALPHABET.length)] ?? "x").join("");

const makeRow = (
  rnd: () => number,
  budget: BudgetSpec,
  models: readonly ModelSpec[],
  prices: PriceBook,
  ts: number,
): Row => {
  const m = weighted(rnd, models);
  const prompt = Math.round(logBetween(rnd, m.prompt[0], m.prompt[1]));
  const completion =
    m.completion[1] > 0 ? Math.round(logBetween(rnd, Math.max(m.completion[0], 1), m.completion[1])) : 0;
  const cached = m.cached[1] > 0 ? Math.round(prompt * between(rnd, m.cached[0], m.cached[1])) : 0;
  const [raw] = prices.costEur(m.id, prompt, completion, cached);
  const failed = rnd() < 0.03;
  const status = failed ? (rnd() < 0.7 ? 429 : 500) : 200;
  return {
    ts,
    account: pick(rnd, budget.accounts),
    pool: budget.pool,
    client: weighted(rnd, budget.pool === "vibe" ? VIBE_CLIENTS : API_CLIENTS).name,
    model: m.id,
    endpoint: m.endpoint,
    prompt,
    completion: failed ? 0 : completion,
    cached: failed ? 0 : cached,
    cost: failed ? 0 : raw,
    status,
    latency: failed ? Math.round(between(rnd, 30, 220)) : Math.round(between(rnd, m.latency[0], m.latency[1])),
  };
};

const generateRows = (
  rnd: () => number,
  budget: BudgetSpec,
  models: readonly ModelSpec[],
  prices: PriceBook,
  now: number,
): Row[] => {
  const out: Row[] = [];
  const first = startOfDay(now - 29 * 86400);
  for (let d = 0; d < 30; d++) {
    const day = first + d * 86400;
    const weekday = new Date(day * 1000).getDay();
    const weekend = weekday === 0 || weekday === 6;
    const base = budget.weight * 3.2;
    const n = Math.max(0, Math.round(base * (weekend ? 0.28 : 1) * between(rnd, 0.55, 1.45)));
    // leave the last few hours to the burst below, so the 5 hour window is not already spent
    const cutoff = d === 29 ? now - 6 * 3600 : day + 86400;
    for (let i = 0; i < n; i++) {
      const ts = day + pickHour(rnd) * 3600 + Math.floor(rnd() * 3600);
      if (ts >= cutoff) continue;
      out.push(makeRow(rnd, budget, models, prices, ts));
    }
  }
  const burst = Math.max(2, Math.round(budget.weight / 9));
  for (let i = 0; i < burst; i++) {
    const ts = now - 120 - Math.floor(rnd() * 6600);
    out.push(makeRow(rnd, budget, models, prices, ts));
  }
  return out;
};

const seedDemo = (db: DB, cfg: Config, rnd: () => number, now: number): DemoData => {
  const store = createStore(db);
  const prices = createPriceBook(cfg.usd_to_eur);
  store.createUser("daniel", "mistwatch-demo", now - 45 * 86400);
  store.createUser("tereza", "mistwatch-demo", now - 20 * 86400);
  const keyToAccount = new Map<string, string>();
  const accountPerson = new Map<string, Person>();
  const accountBudgets = new Map<string, Budget[]>();
  for (const a of ACCOUNTS) {
    store.createAccount(a.name, a.priority, now - 40 * 86400);
    accountPerson.set(a.name, a.person);
    accountBudgets.set(a.name, []);
  }
  for (const b of BUDGETS) {
    for (const account of b.accounts) {
      const key = makeKey(rnd);
      store.setKey(account, b.pool, { value: key });
      keyToAccount.set(key, account);
    }
  }
  const apiKeys = ["vibe-cli", "opencode", "pi", "notebook", "scripts"];
  for (const [i, name] of apiKeys.entries()) {
    const [row] = store.createApiKey(name, now - (60 - i * 7) * 86400);
    db.stmt("UPDATE api_keys SET last_used=? WHERE id=?").run(now - (i * 37 + 4) * 60, row.id);
  }
  const rows: Row[] = [];
  for (const b of BUDGETS) {
    const models = b.pool === "vibe" ? VIBE_MODELS : API_MODELS;
    const generated = generateRows(rnd, b, models, prices, now);
    const raw = generated.reduce((s, r) => s + r.cost, 0);
    const scale = raw > 0 ? b.target / raw : 1;
    for (const r of generated) {
      r.cost = Math.round(r.cost * scale * 1e6) / 1e6;
      rows.push(r);
    }
  }
  db.tx(() => {
    for (const r of rows) {
      db.addLedger({
        ts: r.ts,
        account: r.account,
        pool: r.pool,
        client: r.client,
        model: r.model,
        endpoint: r.endpoint,
        prompt_tokens: r.prompt,
        completion_tokens: r.completion,
        cached_tokens: r.cached,
        cost_eur: r.cost,
        source: "proxy",
        estimated: 0,
        status: r.status,
        latency_ms: r.latency,
      });
    }
  });
  const resetAt = nextReset(1, now);
  for (const b of BUDGETS) {
    const used = rows
      .filter((r) => r.pool === b.pool && b.accounts.includes(r.account))
      .reduce((s, r) => s + r.cost, 0);
    for (const account of b.accounts) {
      db.addSnapshot({
        ts: now,
        account,
        pool: b.pool,
        used_eur: used,
        initial_eur: b.initial,
        reset_at: resetAt,
        currency: "EUR",
      });
      accountBudgets.get(account)?.push({ pool: b.pool, initial: b.initial, used, resetAt });
    }
  }
  return { keyToAccount, accountPerson, accountBudgets };
};

const createFakeMistral = (data: DemoData): Hono => {
  const app = new Hono();
  const keyOf = (c: Context): string => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const personOf = (c: Context): Person | null => {
    const account = data.keyToAccount.get(keyOf(c));
    return account ? (data.accountPerson.get(account) ?? null) : null;
  };
  app.get("/v1/billing/budget", (c) => {
    const account = data.keyToAccount.get(keyOf(c));
    if (!account) return c.json({ detail: "Invalid API key" }, 401);
    const out: Record<string, unknown> = {};
    for (const b of data.accountBudgets.get(account) ?? []) {
      out[b.pool === "vibe" ? "vibe_budget" : "api_budget"] = {
        initial_budget: b.initial,
        usage_percentage: b.initial > 0 ? (b.used / b.initial) * 100 : 0,
        reset_at: new Date(b.resetAt * 1000).toISOString(),
        currency: "EUR",
      };
    }
    return c.json(out);
  });
  app.get("/v1/users/me", (c) => {
    const p = personOf(c);
    if (!p) return c.json({ detail: "Invalid API key" }, 401);
    return c.json({
      first_name: p.first,
      last_name: p.last,
      email: p.email,
      workspace: { name: p.workspace },
      organization: p.org ? { name: p.org } : null,
    });
  });
  app.get("/api/vibe/whoami", (c) => {
    const p = personOf(c);
    if (!p) return c.json({ detail: "Invalid API key" }, 401);
    return c.json({ plan_name: p.plan, plan_type: p.planType });
  });
  app.get("/v1/models", (c) => c.json({ object: "list", data: MODELS }));
  return app;
};

type Args = { port: number; upstreamPort: number; seed: string; help: boolean };
const parseCli = (argv: string[]): Args => {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "8788" },
      "upstream-port": { type: "string", default: "8790" },
      seed: { type: "string", default: "mistwatch" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const port = Number.parseInt(values.port, 10);
  const upstreamPort = Number.parseInt(values["upstream-port"], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535)
    throw new Error("--upstream-port must be 1-65535");
  if (port === upstreamPort) throw new Error("--port and --upstream-port must differ");
  return { port, upstreamPort, seed: values.seed, help: values.help };
};

const main = async (): Promise<void> => {
  const args = parseCli(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  process.env.MISTWATCH_NO_KEYRING = "1";
  const here = dirname(fileURLToPath(import.meta.url));
  const demoDir = join(here, "..", ".demo");
  if (!existsSync(join(here, "..", "dist", "web", "index.html")))
    throw new Error("the web UI is not built yet: run npm run build:web first");
  mkdirSync(demoDir, { recursive: true });
  try {
    for (const f of ["mistwatch.db", "mistwatch.db-wal", "mistwatch.db-shm"]) rmSync(join(demoDir, f), { force: true });
  } catch {
    throw new Error(`could not reset ${demoDir}: stop the running demo first`);
  }
  const seed = args.seed === "random" ? randomUUID() : args.seed;
  const rnd = mulberry32(hashSeed(seed));
  const now = Math.floor(Date.now() / 1000);
  const cfg = defaultConfig();
  cfg.db_path = join(demoDir, "mistwatch.db");
  cfg.port = args.port;
  cfg.upstream = `http://127.0.0.1:${args.upstreamPort}`;
  cfg.console_upstream = cfg.upstream;
  cfg.limits.sync_interval_s = 300;
  const db = openDb(cfg.db_path);
  const data = seedDemo(db, cfg, rnd, now);
  db.close();
  const fake = serve({ fetch: createFakeMistral(data).fetch, hostname: "127.0.0.1", port: args.upstreamPort });
  await new Promise<void>((ok, fail) => {
    fake.once("listening", ok);
    fake.once("error", fail);
  });
  console.log(`mistwatch demo: ${ACCOUNTS.length} accounts, ${BUDGETS.length} budgets, seed "${seed}"`);
  console.log("  sign in  daniel / mistwatch-demo");
  console.log(`  data     ${cfg.db_path}`);
  console.log(`  fake Mistral upstream on 127.0.0.1:${args.upstreamPort}`);
  await startServer(cfg);
};

try {
  await main();
} catch (e) {
  console.error(`mistwatch demo: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
