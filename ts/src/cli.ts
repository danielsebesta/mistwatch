#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dumpJson, merge, opencode, pi } from "./agents.ts";
import type { PoolStatusDict } from "./types.ts";

const TEMPLATE = `# mistwatch config (server, limits, pricing). Accounts, keys and logins are managed in the web UI.
[server]
host = "127.0.0.1"
port = 8787

[upstream]
base_url = "https://api.mistral.ai"

[pricing]
usd_to_eur = 0.86          # docs prices are USD, budgets are EUR

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
const USAGE = `usage: mistwatch <command> [options]

commands:
  init           write the config template (--force, --import-vibe)
  import-vibe    add the Vibe CLI keyring login as an account (--name)
  status         budget status of every account/pool (--json)
  sync           pull budget usage from Mistral now
  serve          run the proxy and web UI (--port)
  route          dry-run the auto router on a prompt (--model --tools --llm --pressure)
  passwd         create a user / reset a password
  vibe-config    print the Vibe CLI provider block
  agent-config   provider config for pi|opencode (--write, --env)`;
const openApp = async () => {
  const { loadConfig } = await import("./config.ts");
  const { openDb } = await import("./db.ts");
  const { createStore } = await import("./store.ts");
  const cfg = loadConfig();
  const db = openDb(cfg.db_path);
  const store = createStore(db);
  store.migrateConfig(cfg);
  cfg.accounts.splice(0, cfg.accounts.length, ...store.listAccounts());
  return { cfg, db, store };
};
const serverUrl = (cfg: { host: string; port: number }): string => `http://${cfg.host}:${cfg.port}`;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
let stdinQueue: string[] | null = null;
const stdinLines = async (): Promise<string[]> => {
  if (stdinQueue === null) {
    let all = "";
    process.stdin.setEncoding("utf8");
    for await (const c of process.stdin) all += c;
    stdinQueue = all.split("\n");
  }
  return stdinQueue;
};
const readStdinAll = async (): Promise<string> => (await stdinLines()).join("\n").replace(/\r/g, "");
const readPassword = async (prompt: string): Promise<string> => {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) return ((await stdinLines()).shift() ?? "").replace(/\r$/, "");
  return new Promise((res) => {
    stdin.setRawMode(true);
    stdin.resume();
    let pw = "";
    const done = (): void => {
      stdin.removeAllListeners("data");
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      res(pw);
    };
    stdin.on("data", (c: Buffer) => {
      for (const b of c.toString("utf8")) {
        if (b === "\r" || b === "\n" || b === "\u0004" || b === "\u001a") return done();
        if (b === "\u0003") process.exit(130);
        else if (b === "\b" || b === "\u007f") pw = pw.slice(0, -1);
        else pw += b;
      }
      return;
    });
  });
};
const fmtTs = (ts: number | null | undefined): string => {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const f2 = (n: number): string => n.toFixed(2);
const f3 = (n: number): string => n.toFixed(3);
type PoolRow = {
  account: string;
  pool: string;
  blocked_by: string | null;
  used_eur: number;
  initial_eur: number;
  days_left: number;
  daily_fair_share_eur: number;
  room_eur: number;
  retry_at: number | null;
  month: { cap: number; spent: number; room: number };
  windows: Record<string, { cap: number; spent: number; room: number; retry_at: number | null }>;
};
const fmtStatus = (d: {
  last_sync: number | null;
  pools: PoolRow[];
  by_client_7d: { client: string; account: string; pool: string; n: number; cost_eur: number }[];
}): string => {
  const lines = [`sync: ${fmtTs(d.last_sync)}`];
  for (const p of d.pools) {
    const flag = p.blocked_by ? `BLOCKED(${p.blocked_by})` : "ok";
    lines.push(
      `\n[${p.account}/${p.pool}] ${flag}  used ${f2(p.used_eur)} / ${f2(p.initial_eur)} EUR ` +
        `(${((p.used_eur / p.initial_eur) * 100).toFixed(1)} %)  reset in ${p.days_left.toFixed(1)} d`,
    );
    lines.push(
      `   fair share/day: ${f3(p.daily_fair_share_eur)} EUR   room now: ${f3(p.room_eur)} EUR` +
        (p.retry_at ? `   retry: ${fmtTs(p.retry_at)}` : ""),
    );
    const m = p.month;
    lines.push(
      `   ${"month".padStart(6)}  spent ${f3(m.spent).padStart(8)}  cap ${f3(m.cap).padStart(8)}  room ${f3(m.room).padStart(8)}`,
    );
    for (const [n, w] of Object.entries(p.windows))
      lines.push(
        `   ${n.padStart(6)}  spent ${f3(w.spent).padStart(8)}  cap ${f3(w.cap).padStart(8)}  room ${f3(w.room).padStart(8)}` +
          (w.retry_at ? `  free again ${fmtTs(w.retry_at)}` : ""),
      );
  }
  if (d.by_client_7d.length) {
    lines.push("\nlast 7 days by client:");
    for (const r of d.by_client_7d)
      lines.push(
        `   ${r.client.padEnd(14)} ${r.account}/${r.pool.padEnd(5)} ${String(r.n).padStart(5)} req  ${f3(r.cost_eur)} EUR`,
      );
  }
  return lines.join("\n");
};
class ArgError extends Error {}
type ArgConfig = NonNullable<Parameters<typeof parseArgs>[0]>;
const opts = <T extends ArgConfig>(cfg: T): ReturnType<typeof parseArgs<T>> => {
  try {
    return parseArgs(cfg);
  } catch (e) {
    console.error(`mistwatch: ${e instanceof Error ? e.message : String(e)}`);
    throw new ArgError();
  }
};
const cmdInit = async (args: string[]): Promise<number> => {
  const { values } = opts({
    args,
    options: { force: { type: "boolean", default: false }, "import-vibe": { type: "boolean", default: false } },
    strict: true,
  });
  const { configPath } = await import("./config.ts");
  const p = configPath();
  if (existsSync(p) && !values.force) {
    console.log(`${p} already exists (use --force)`);
    return 1;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, TEMPLATE, "utf8");
  console.log(`wrote ${p}`);
  if (values["import-vibe"]) return cmdImportVibe(["--name", "vibe-login"]);
  console.log("Next: `mistwatch serve`, then open the web UI to create your login and add keys.");
  return 0;
};
const cmdImportVibe = async (args: string[]): Promise<number> => {
  const { values } = opts({
    args,
    options: { name: { type: "string", default: "vibe-login" } },
    strict: true,
  });
  const { VIBE_REF, StoreError, vibeCliKeyPresent } = await import("./store.ts");
  if (!vibeCliKeyPresent()) {
    console.log("No Vibe CLI key found in the OS keyring (run `vibe --setup` first).");
    return 1;
  }
  const { store } = await openApp();
  const name = values.name;
  try {
    if (!store.getAccount(name)) store.createAccount(name);
    store.setKey(name, "vibe", { ref: VIBE_REF });
  } catch (e) {
    if (e instanceof StoreError) {
      console.log(e.message);
      return 1;
    }
    throw e;
  }
  console.log(`account '${name}' now follows the Vibe CLI login`);
  return 0;
};
const cmdPasswd = async (args: string[]): Promise<number> => {
  const { positionals } = opts({ args, allowPositionals: true, strict: true });
  const [username] = positionals;
  if (!username) {
    console.error("mistwatch: passwd requires a username");
    return 2;
  }
  const { store } = await openApp();
  const { StoreError } = await import("./store.ts");
  const pw = await readPassword("New password: ");
  if (pw !== (await readPassword("Again: "))) {
    console.log("Passwords differ.");
    return 1;
  }
  try {
    const u = store.findUser(username);
    if (u) {
      store.setPassword(u.id, pw);
      store.deleteOtherSessions(u.id, null);
    } else {
      store.createUser(username, pw);
    }
  } catch (e) {
    if (e instanceof StoreError) {
      console.log(e.message);
      return 1;
    }
    throw e;
  }
  console.log("ok");
  return 0;
};
const cmdStatus = async (args: string[]): Promise<number> => {
  const { values } = opts({ args, options: { json: { type: "boolean", default: false } }, strict: true });
  const { createBudgetEngine, poolStatusDict } = await import("./budget.ts");
  const { cfg, db } = await openApp();
  const eng = createBudgetEngine(db, cfg.limits);
  const pools: PoolStatusDict[] = [];
  const d = {
    last_sync: 0,
    pools,
    by_client_7d: db.byClientSince(Date.now() / 1000 - 7 * 86400),
  };
  for (const acc of cfg.accounts) {
    for (const pool of ["vibe", "api"]) {
      const s = eng.status(acc.name, pool);
      if (s) d.pools.push(poolStatusDict(s));
    }
  }
  console.log(values.json ? dumpJson(d) : fmtStatus(d));
  return 0;
};
const cmdSync = async (): Promise<number> => {
  const { syncAll } = await import("./sync.ts");
  const { cfg, db } = await openApp();
  console.log(dumpJson(await syncAll(fetch, cfg, db)));
  return 0;
};
const cmdServe = async (args: string[]): Promise<number> => {
  const { values } = opts({ args, options: { port: { type: "string" } }, strict: true });
  const { loadConfig } = await import("./config.ts");
  const { startServer } = await import("./app.ts");
  const cfg = loadConfig();
  if (values.port !== undefined) {
    const port = Number.parseInt(values.port, 10);
    if (!Number.isFinite(port)) {
      console.error("mistwatch: --port must be an integer");
      return 2;
    }
    cfg.port = port;
  }
  await startServer(cfg);
  return 0;
};
const cmdRoute = async (args: string[]): Promise<number> => {
  const { values, positionals } = opts({
    args,
    allowPositionals: true,
    options: {
      model: { type: "string", default: "auto" },
      tools: { type: "boolean", default: false },
      llm: { type: "boolean", default: false },
      pressure: { type: "string", default: "1.0" },
    },
    strict: true,
  });
  const pressure = Number.parseFloat(values.pressure);
  if (!Number.isFinite(pressure)) {
    console.error("mistwatch: --pressure must be a number");
    return 2;
  }
  const { decide } = await import("./router.ts");
  const prompt = positionals.length ? positionals.join(" ") : await readStdinAll();
  const body: Record<string, unknown> = { messages: [{ role: "user", content: prompt }] };
  if (values.tools) body.tools = [{ type: "function" }];
  let llm: number | null = null;
  if (values.llm) {
    const { rate } = await import("./classifier.ts");
    const { keyFor } = await import("./config.ts");
    const { cfg } = await openApp();
    const acc = cfg.accounts.find((x) => Object.keys(x.keys).length > 0);
    if (!acc) {
      console.error("mistwatch: no account with keys configured");
      return 1;
    }
    const pool = "api" in acc.keys ? "api" : (Object.keys(acc.keys)[0] ?? "api");
    const res = await rate(
      fetch,
      cfg.upstream,
      keyFor(acc, pool) ?? "",
      body,
      cfg.router.classifier_model,
      cfg.router.classifier_timeout_s,
    );
    llm = res ? res[0] : null;
    console.log(`tiny LLM (${cfg.router.classifier_model}): ${llm ?? "None"}`);
  }
  const d = decide(body, values.model, pressure, llm);
  console.log(`${d.model}  effort=${d.effort ?? "None"}  level=${d.level}/6  score=${d.score}/10`);
  console.log(`  ${d.reason}`);
  return 0;
};
const cmdVibeConfig = async (): Promise<number> => {
  const { loadConfig } = await import("./config.ts");
  const url = serverUrl(loadConfig());
  console.log(`Point Vibe CLI at the proxy: add to ~/.vibe/config.toml

[[providers]]
name = "mistwatch"
api_base = "${url}/v1"
api_key_env_var = "MISTWATCH_TOKEN"
backend = "mistral"

# then re-point your models' provider = "mistwatch" and set
#   MISTWATCH_TOKEN=<a key generated on the "API keys" page of the web UI>
Other tools: base URL ${url}/v1, API key = that same key.`);
  return 0;
};
const cmdAgentConfig = async (args: string[]): Promise<number> => {
  const { values, positionals } = opts({
    args,
    allowPositionals: true,
    options: { write: { type: "boolean", default: false }, env: { type: "string", default: "MISTWATCH_TOKEN" } },
    strict: true,
  });
  const [tool] = positionals;
  if (tool !== "pi" && tool !== "opencode") {
    console.error("mistwatch: agent-config requires tool 'pi' or 'opencode'");
    return 2;
  }
  const { loadConfig } = await import("./config.ts");
  const env = values.env;
  const base = serverUrl(loadConfig());
  const home = homedir();
  const data = tool === "pi" ? pi(base, env) : opencode(base, env);
  const path =
    tool === "pi" ? join(home, ".pi", "agent", "models.json") : join(home, ".config", "opencode", "opencode.json");
  if (!values.write) {
    console.log(`# ${path}\n${dumpJson(data)}`);
    console.error(`\n# set ${env}=<a key from the API keys page>; add --write to merge this into the file`);
    return 0;
  }
  let cur: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e;
  }
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRec(parsed)) throw new SyntaxError("not plain JSON");
      cur = parsed;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      console.log(`${path} is not plain JSON (comments?); not touching it. Paste the block above manually.`);
      return 1;
    }
    writeFileSync(`${path}.bak`, raw, "utf8");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${dumpJson(merge(cur, data))}\n`, "utf8");
  console.log(`wrote ${path} (backup: .json.bak). Set ${env}=<key from the API keys page>.`);
  return 0;
};
export const main = async (argv: string[]): Promise<number> => {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === undefined) {
      console.error(USAGE);
      return 2;
    }
    if (cmd === "-h" || cmd === "--help" || cmd === "help") {
      console.log(USAGE);
      return 0;
    }
    if (cmd === "init") return await cmdInit(rest);
    if (cmd === "import-vibe") return await cmdImportVibe(rest);
    if (cmd === "passwd") return await cmdPasswd(rest);
    if (cmd === "status") return await cmdStatus(rest);
    if (cmd === "sync") return await cmdSync();
    if (cmd === "serve") return await cmdServe(rest);
    if (cmd === "route") return await cmdRoute(rest);
    if (cmd === "vibe-config") return await cmdVibeConfig();
    if (cmd === "agent-config") return await cmdAgentConfig(rest);
    console.error(`mistwatch: unknown command '${cmd}'`);
    return 2;
  } catch (e) {
    if (e instanceof ArgError) return 2;
    throw e;
  }
};
const invoked = (): boolean => {
  const arg = process.argv[1];
  if (!arg) return false;
  const norm = (p: string): string => {
    try {
      return realpathSync(p).toLowerCase();
    } catch {
      return resolve(p).toLowerCase();
    }
  };
  return norm(arg) === norm(fileURLToPath(import.meta.url));
};
if (invoked()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
