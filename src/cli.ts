#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dumpJson, opencode, opencodeConfigPath, pi } from "./agents.ts";
import { clientBaseUrl } from "./config.ts";
import { readSecret as readPassword, readStdinAll } from "./secret.ts";
import type { PoolStatusDict } from "./types.ts";

const USAGE = `usage: mistwatch <command> [options]

commands:
  setup          one-step setup for your tools (--yes --harness --port --start --json)
  init           write the config template (--force, --import-vibe)
  import-vibe    add the Vibe CLI keyring login as an account (--name)
  status         budget status of every account/pool (--json)
  sync           pull budget usage from Mistral now
  boost          lift the 5 h and day limits for 5 hours, once per day (--status)
  serve          run the proxy and web UI (--port)
  route          dry-run the auto router on a prompt (--tools --llm --pressure)
  passwd         create a user / reset a password
  set-token      store a Mistwatch key as MISTWATCH_TOKEN (--url, --no-check)
  vibe-config    print the Vibe CLI provider block
  agent-config   provider config for pi|opencode (--write, --env)`;
const openApp = async () => (await import("./open.ts")).openApp();
const serverUrl = (cfg: { host: string; port: number }): string => clientBaseUrl(cfg);

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
  const { configPath, CONFIG_TEMPLATE } = await import("./config.ts");
  const p = configPath();
  if (existsSync(p) && !values.force) {
    console.log(`${p} already exists (use --force)`);
    return 1;
  }
  const { applyFile } = await import("./setup.ts");
  const res = applyFile(p, () => CONFIG_TEMPLATE, new Date());
  console.log(`wrote ${p}${res.backup ? ` (backup: ${res.backup})` : ""}`);
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
  const { StoreError, vibeCliKeyPresent } = await import("./store.ts");
  const { linkVibeLogin } = await import("./open.ts");
  if (!vibeCliKeyPresent()) {
    console.log("No Vibe CLI key found in the OS keyring (run `vibe --setup` first).");
    return 1;
  }
  const { store } = await openApp();
  const name = values.name;
  try {
    linkVibeLogin(store, name);
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
const cmdSetup = async (args: string[]): Promise<number> => {
  const { runSetup, defaultSetupDeps } = await import("./setup.ts");
  return runSetup(args, defaultSetupDeps());
};
// Asks for a Mistwatch key (typing hidden), checks it against the server and stores it as MISTWATCH_TOKEN.
const cmdSetToken = async (args: string[]): Promise<number> => {
  const { values } = opts({
    args,
    options: { url: { type: "string" }, "no-check": { type: "boolean", default: false } },
    strict: true,
  });
  const { parseUrl, backupFile, createAsk } = await import("./setup.ts");
  const { checkKey, persistToken, TOKEN_ENV } = await import("./envtoken.ts");
  let url: string;
  try {
    const given = parseUrl(values.url);
    if (given) url = given;
    else {
      const { loadConfig } = await import("./config.ts");
      url = (() => {
        try {
          return serverUrl(loadConfig());
        } catch {
          return "http://127.0.0.1:8787";
        }
      })();
    }
  } catch (e) {
    console.error(`mistwatch: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const key = (await readPassword("Mistwatch key (typing is hidden): ")).trim();
  if (!key.startsWith("mw-")) {
    console.error(
      'mistwatch: that does not look like a Mistwatch key (it starts with "mw-"). Create one under "API keys" in the web UI.',
    );
    return 1;
  }
  if (!values["no-check"]) {
    const verdict = await checkKey(url, key);
    if (verdict === "rejected") {
      console.error(`mistwatch: ${url} rejected this key, nothing saved`);
      return 1;
    }
    if (verdict === "unreachable")
      console.error(`mistwatch: could not reach ${url} to check the key, saving it anyway`);
  }
  const line = createAsk();
  try {
    const r = await persistToken(key, {
      platform: process.platform,
      home: homedir(),
      shell: process.env.SHELL,
      now: () => new Date(),
      backup: backupFile,
      confirm: async (q) => {
        const a = ((await line.ask(`${q} [Y/n] `)) ?? "n").trim().toLowerCase();
        return a === "" || a === "y" || a === "yes";
      },
    });
    if (r.saved) {
      console.log(`Stored as ${TOKEN_ENV} in ${r.where}; ${r.note}.`);
      return 0;
    }
    console.error(`mistwatch: ${r.reason}. To do it by hand: ${r.manual.replace("<key>", "<your key>")}`);
    return 1;
  } finally {
    line.close();
  }
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
  let lastSync = 0;
  for (const acc of cfg.accounts)
    for (const pool of ["vibe", "api"]) lastSync = Math.max(lastSync, db.latestSnapshot(acc.name, pool)?.ts ?? 0);
  const d = {
    last_sync: lastSync,
    pools,
    by_client_7d: db.byClientSince(Date.now() / 1000 - 7 * 86400),
  };
  for (const acc of cfg.accounts) {
    for (const pool of ["vibe", "api"]) {
      const s = eng.status(acc.name, pool);
      if (s) d.pools.push(poolStatusDict(s));
    }
  }
  db.close();
  console.log(values.json ? dumpJson(d) : fmtStatus(d));
  return 0;
};
const cmdBoost = async (args: string[]): Promise<number> => {
  const { values } = opts({ args, options: { status: { type: "boolean", default: false } }, strict: true });
  const { boostInfo, startBoost } = await import("./budget.ts");
  const { db } = await openApp();
  try {
    const until = (t: number | null): string => (t === null ? "" : new Date(t * 1000).toLocaleTimeString());
    if (values.status) {
      const b = boostInfo(db);
      console.log(
        b.active ? `Boost active until ${until(b.until)}` : b.available ? "Boost available" : "Boost used today",
      );
      return 0;
    }
    const b = startBoost(db);
    console.log(`Boost on until ${until(b.until)}. The 5 h and day limits are lifted; week and month still apply.`);
    return 0;
  } catch (e) {
    if (e instanceof RangeError) {
      console.error(`mistwatch: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    db.close();
  }
};
const cmdSync = async (): Promise<number> => {
  const { syncAll } = await import("./sync.ts");
  const { cfg, db } = await openApp();
  const res = await syncAll(fetch, cfg, db);
  db.close();
  console.log(dumpJson(res));
  return 0;
};
const cmdServe = async (args: string[]): Promise<number> => {
  const { values } = opts({ args, options: { port: { type: "string" } }, strict: true });
  const { loadConfig } = await import("./config.ts");
  const { startServer } = await import("./app.ts");
  const cfg = loadConfig();
  if (values.port !== undefined) {
    const { parsePort } = await import("./setup.ts");
    try {
      cfg.port = parsePort(values.port) ?? cfg.port;
    } catch (e) {
      console.error(`mistwatch: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }
  await startServer(cfg);
  return 0;
};
const cmdRoute = async (args: string[]): Promise<number> => {
  const { values, positionals } = opts({
    args,
    allowPositionals: true,
    options: {
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
  const { decide, TOP } = await import("./router.ts");
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
  const d = decide(body, pressure, llm);
  console.log(`${d.model}  effort=${d.effort ?? "None"}  level=${d.level}/${TOP}  score=${d.score}/20`);
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
  const path = tool === "pi" ? join(home, ".pi", "agent", "models.json") : opencodeConfigPath(home, process.platform);
  if (!values.write) {
    console.log(`# ${path}\n${dumpJson(data)}`);
    console.error(`\n# set ${env}=<a key from the API keys page>; add --write to merge this into the file`);
    return 0;
  }
  const { applyFile, planJson, SetupError } = await import("./setup.ts");
  try {
    const res = applyFile(path, (raw) => planJson(raw, data), new Date());
    console.log(
      res.action === "unchanged"
        ? `${path} is already up to date`
        : `wrote ${path}${res.backup ? ` (backup: ${res.backup})` : ""}. Set ${env}=<key from the API keys page>.`,
    );
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    console.log(`${path}: ${e.message}. Paste the block above manually.`);
    return 1;
  }
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
    if (cmd === "setup") return await cmdSetup(rest);
    if (cmd === "init") return await cmdInit(rest);
    if (cmd === "import-vibe") return await cmdImportVibe(rest);
    if (cmd === "passwd") return await cmdPasswd(rest);
    if (cmd === "set-token") return await cmdSetToken(rest);
    if (cmd === "status") return await cmdStatus(rest);
    if (cmd === "sync") return await cmdSync();
    if (cmd === "boost") return await cmdBoost(rest);
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
