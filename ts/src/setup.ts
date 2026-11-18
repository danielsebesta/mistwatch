import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Interface } from "node:readline/promises";
import { WriteStream } from "node:tty";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { parse } from "smol-toml";
import { ENV, merge, opencode, opencodeConfigPath, pi, TOOLS, vibe } from "./agents.ts";
import { createBudgetEngine } from "./budget.ts";
import { CONFIG_TEMPLATE, configPath } from "./config.ts";
import { type App, linkVibeLogin, openApp } from "./open.ts";
import type { Store } from "./store.ts";
import { mask, StoreError, VIBE_REF, vibeCliKeyPresent } from "./store.ts";
import type { Config } from "./types.ts";
import { POOLS } from "./types.ts";

export type Harness = "vibe" | "opencode" | "pi";
export const HARNESSES: readonly Harness[] = ["vibe", "opencode", "pi"];
export type SetupOptions = {
  yes: boolean;
  harness: Harness[] | null;
  port: number | null;
  noBanner: boolean;
  start: boolean;
  json: boolean;
  showToken: boolean;
  force: boolean;
  help: boolean;
};
export type ColorDepth = 0 | 4 | 8 | 24;
export type SetupIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  ask: (question: string) => Promise<string | null>;
  close: () => void;
  interactive: boolean;
  depth: ColorDepth;
};
export type SetupDeps = {
  io: SetupIo;
  home: string;
  vibeHome: string;
  platform: NodeJS.Platform;
  now: () => Date;
  vibeKeyPresent: () => boolean;
  start: (cfg: Config) => Promise<unknown>;
};
export class SetupArgError extends Error {}
class SetupError extends Error {}
const FLAGS = {
  yes: { type: "boolean", short: "y", default: false },
  harness: { type: "string" },
  port: { type: "string" },
  "no-banner": { type: "boolean", default: false },
  start: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  "show-token": { type: "boolean", default: false },
  force: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const satisfies ParseArgsOptionsConfig;
export const SETUP_USAGE = `usage: mistwatch setup [options]

Creates the config, links your Vibe CLI login, makes a client token and writes the
provider config of the tools you pick. Safe to run again: nothing is overwritten
without a timestamped .bak copy, and unchanged files are left alone.

options:
  -y, --yes            never ask, use defaults (also when stdin is not a terminal)
      --harness LIST   comma-separated: vibe, opencode, pi or all (default: vibe)
      --port N         write this port into config.toml and the tool configs (default: keep the configured one, 8787 for a new config)
      --start          run the proxy when setup is done
      --no-banner      skip the logo
      --json           print what was done as JSON; no client token is created unless --show-token is also given
      --show-token     with --json: create the client token (if none exists) and include it in the output
      --force          replace an existing config.toml (a backup is kept)
  -h, --help           show this help`;
const isHarness = (s: string): s is Harness => (HARNESSES as readonly string[]).includes(s);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const parseHarnesses = (raw: string): Harness[] => {
  const names = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes("all")) return [...HARNESSES];
  const bad = names.filter((n) => !isHarness(n));
  if (names.length === 0 || bad.length > 0)
    throw new SetupArgError(`--harness expects ${HARNESSES.join(", ")} or all (got '${bad.join(",") || raw}')`);
  return HARNESSES.filter((h) => names.includes(h));
};
const parsePort = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const port = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  if (port < 1 || port > 65535) throw new SetupArgError(`--port expects an integer from 1 to 65535 (got '${raw}')`);
  return port;
};
const parseFlags = (args: string[]) => {
  try {
    return parseArgs({ args, options: FLAGS, strict: true }).values;
  } catch (e) {
    throw new SetupArgError(errText(e));
  }
};
export const parseSetupArgs = (args: string[]): SetupOptions => {
  const v = parseFlags(args);
  if (v.json && v.start)
    throw new SetupArgError("--json and --start cannot be combined (server logs would mix into the JSON)");
  return {
    yes: v.yes,
    harness: v.harness === undefined ? null : parseHarnesses(v.harness),
    port: parsePort(v.port),
    noBanner: v["no-banner"],
    start: v.start,
    json: v.json,
    showToken: v["show-token"],
    force: v.force,
    help: v.help,
  };
};
type Rgb = readonly [number, number, number];
const SEED: Rgb = [255, 130, 4];
const GOOD: Rgb = [140, 216, 147];
const WARN: Rgb = [227, 198, 0];
const BAD: Rgb = [255, 140, 130];
const ANSI16: readonly Rgb[] = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];
const dist = (a: Rgb, b: Rgb): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const to16 = (c: Rgb): number => {
  let best = 0;
  ANSI16.forEach((p, i) => {
    if (dist(c, p) < dist(c, ANSI16[best] ?? p)) best = i;
  });
  return best;
};
const level = (v: number): number => {
  let best = 0;
  CUBE.forEach((l, i) => {
    if (Math.abs(l - v) < Math.abs((CUBE[best] ?? 0) - v)) best = i;
  });
  return best;
};
const to256 = (c: Rgb): number => 16 + 36 * level(c[0]) + 6 * level(c[1]) + level(c[2]);
const sgr = (depth: ColorDepth, kind: 38 | 48, c: Rgb): string => {
  if (depth === 24) return `\x1b[${kind};2;${c[0]};${c[1]};${c[2]}m`;
  if (depth === 8) return `\x1b[${kind};5;${to256(c)}m`;
  const i = to16(c);
  return `\x1b[${(kind === 38 ? (i < 8 ? 30 : 82) : i < 8 ? 40 : 92) + i}m`;
};
const RESET = "\x1b[0m";
export type Style = {
  unicode: boolean;
  paint: (text: string, c: Rgb) => string;
  accent: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  cell: (top: Rgb | null, bottom: Rgb | null) => string;
};
export const createStyle = (depth: ColorDepth): Style => {
  const on = depth > 0;
  const wrap = (open: string, text: string): string => (on ? `${open}${text}${RESET}` : text);
  const paint = (text: string, c: Rgb): string => wrap(on ? sgr(depth, 38, c) : "", text);
  return {
    unicode: on,
    paint,
    accent: (text) => wrap(`\x1b[1m${on ? sgr(depth, 38, SEED) : ""}`, text),
    bold: (text) => wrap("\x1b[1m", text),
    dim: (text) => wrap("\x1b[2m", text),
    cell: (top, bottom) => {
      if (!on) return " ";
      if (top && bottom) {
        const same = top[0] === bottom[0] && top[1] === bottom[1] && top[2] === bottom[2];
        return `${sgr(depth, 38, top)}${same ? "" : sgr(depth, 48, bottom)}${same ? "█" : "▀"}${RESET}`;
      }
      if (top) return `${sgr(depth, 38, top)}▀${RESET}`;
      return bottom ? `${sgr(depth, 38, bottom)}▄${RESET}` : " ";
    },
  };
};
export const detectDepth = (
  env: NodeJS.ProcessEnv,
  tty: boolean,
  probe: (env: NodeJS.ProcessEnv) => number,
): ColorDepth => {
  if (!tty || env.NO_COLOR || env.TERM === "dumb") return 0;
  const bits = probe(env);
  return bits >= 24 ? 24 : bits >= 8 ? 8 : bits >= 4 ? 4 : 0;
};
const MARK = ["Y...Y.A.A.A", "YY.AA.O.O.O", "A.A.A.O.O.R", "O...O..R.R.", "O...R..E.E."];
const SHADES: Record<string, Rgb> = {
  Y: [255, 194, 51],
  A: [255, 162, 31],
  O: [255, 127, 42],
  R: [249, 90, 59],
  E: [232, 56, 79],
};
const pixel = (row: number, col: number): Rgb | null => SHADES[MARK[row]?.[col] ?? "."] ?? null;
export const banner = (style: Style, tagline: string): string[] => {
  const text = [style.accent("mistwatch"), style.dim(tagline), style.dim("setup")];
  if (!style.unicode) {
    const rows = MARK.map((r) => r.replace(/\./g, "  ").replace(/[A-Z]/g, "##").trimEnd());
    return rows.map((r, i) => `  ${r.padEnd(24)}${i > 0 && i < 4 ? (text[i - 1] ?? "") : ""}`.trimEnd());
  }
  return [0, 1, 2].map((r) => {
    const cells = Array.from({ length: MARK[0]?.length ?? 0 }, (_, c) =>
      style.cell(pixel(r * 2, c), pixel(r * 2 + 1, c)),
    );
    return `  ${cells.join("")}   ${text[r] ?? ""}`;
  });
};
const stamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
export const backupFile = (path: string, now: Date): string => {
  let n = 0;
  let dest = `${path}.${stamp(now)}.bak`;
  while (existsSync(dest)) dest = `${path}.${stamp(now)}-${++n}.bak`;
  copyFileSync(path, dest, constants.COPYFILE_EXCL);
  return dest;
};
const danglingTarget = (path: string): string => {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
  } catch {
    return path;
  }
};
const resolveTarget = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return danglingTarget(path);
  }
};
type FileAction = "created" | "updated" | "unchanged";
export const applyFile = (
  path: string,
  plan: (raw: string | null) => string | null,
  now: Date,
): { action: FileAction; backup: string | null } => {
  const target = resolveTarget(path);
  const raw = existsSync(target) ? readFileSync(target, "utf8") : null;
  const next = plan(raw);
  if (next === null) return { action: "unchanged", backup: null };
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.mistwatch-tmp`;
  let backup: string | null = null;
  try {
    writeFileSync(tmp, next, "utf8");
    if (raw !== null) {
      chmodSync(tmp, statSync(target).mode & 0o7777);
      backup = backupFile(path, now);
    }
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (backup) rmSync(backup, { force: true });
    throw e;
  }
  return { action: raw === null ? "created" : "updated", backup };
};
export const planJson = (raw: string | null, data: Record<string, unknown>): string | null => {
  let cur: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/^﻿/, ""));
    } catch {
      throw new SetupError("not plain JSON (comments?), left untouched; merge the block by hand");
    }
    if (!isRec(parsed)) throw new SetupError("not a JSON object, left untouched");
    cur = parsed;
  }
  const next = merge(structuredClone(cur), data);
  return raw !== null && JSON.stringify(next) === JSON.stringify(cur) ? null : `${JSON.stringify(next, null, 2)}\n`;
};
const MW_NAME = /^\s*name\s*=\s*(["'])mistwatch\1\s*(#.*)?$/;
const providerOf = (doc: Record<string, unknown>): Record<string, unknown> | null => {
  const list = doc.providers;
  return Array.isArray(list)
    ? (list.find((p): p is Record<string, unknown> => isRec(p) && p.name === "mistwatch") ?? null)
    : null;
};
const providerMatches = (text: string, base: string): boolean => {
  try {
    const p = providerOf(parse(text));
    return p?.api_base === `${base}/v1` && p.api_key_env_var === ENV && p.backend === "mistral";
  } catch {
    return false;
  }
};
const replaceProvider = (lines: string[], head: string[]): string[] | null => {
  for (const [s, line] of lines.entries()) {
    if (line.trim() !== "[[providers]]") continue;
    let e = s + 1;
    while (e < lines.length && !/^\s*\[/.test(lines[e] ?? "")) e++;
    if (lines.slice(s + 1, e).some((l) => MW_NAME.test(l)))
      return [...lines.slice(0, s), ...head, ...(e < lines.length ? [""] : []), ...lines.slice(e)];
  }
  return null;
};
export const planToml = (raw: string | null, base: string): string | null => {
  const block = vibe(base);
  if (raw === null || raw.trim() === "") return block;
  try {
    parse(raw);
  } catch {
    throw new SetupError("not valid TOML, left untouched; add the provider block by hand");
  }
  if (providerMatches(raw, base)) return null;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const existing = providerOf(parse(raw));
  const head = (block.split("\n\n")[0] ?? "").split("\n");
  const replaced = existing ? replaceProvider(raw.split(/\r?\n/), head) : null;
  const next = replaced ? replaced.join(eol) : `${raw.trimEnd()}${eol}${eol}${block.replace(/\n/g, eol)}`;
  if (!providerMatches(next, base))
    throw new SetupError("could not edit the existing mistwatch provider; edit it by hand");
  return next;
};
const SERVER_HEAD = /^\s*\[\s*server\s*\]\s*(#.*)?$/;
const PORT_LINE = /^(\s*port\s*=\s*)\d+(\s*(?:#.*)?)$/;
const serverPort = (text: string): unknown => {
  const server = parse(text).server;
  return isRec(server) ? server.port : undefined;
};
export const planPort = (raw: string, port: number): string | null => {
  try {
    if (serverPort(raw) === port) return null;
  } catch {
    throw new SetupError("not valid TOML, left untouched; set [server] port by hand");
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const head = lines.findIndex((l) => SERVER_HEAD.test(l));
  let next: string;
  if (head === -1) {
    next = `${raw.trimEnd()}${raw.trim() === "" ? "" : eol + eol}[server]${eol}port = ${port}${eol}`;
  } else {
    let end = head + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++;
    const at = lines.findIndex((l, i) => i > head && i < end && PORT_LINE.test(l));
    if (at === -1) lines.splice(head + 1, 0, `port = ${port}`);
    else lines[at] = (lines[at] ?? "").replace(PORT_LINE, `$1${port}$2`);
    next = lines.join(eol);
  }
  try {
    if (serverPort(next) === port) return next;
  } catch {
    // reported below
  }
  throw new SetupError("could not set [server] port in config.toml; edit it by hand");
};
type Status = "ok" | "warn" | "fail" | "skip";
type Step = { step: string; status: Status; message: string };
type HarnessResult = { harness: Harness; path: string; action: FileAction | "failed"; backup: string | null };
type Report = {
  ok: boolean;
  steps: Step[];
  config: { path: string; action: "created" | "kept" | "replaced" | "updated" | "failed"; backup: string | null };
  vibe_login: "imported" | "linked" | "missing" | "failed";
  client_token: { created: boolean; existing_keys: number; masked: string | null; token?: string; hint?: string };
  harnesses: HarnessResult[];
  status: { ok: boolean; accounts: number; pools_with_budget: number } | null;
  started: boolean;
};
type Ctx = {
  deps: SetupDeps;
  opts: SetupOptions;
  style: Style;
  auto: boolean;
  report: Report;
  newToken: string | null;
  say: (line: string) => void;
};
const MARKS: Record<Status, { glyph: string; ascii: string; color: Rgb | null }> = {
  ok: { glyph: "✓", ascii: "[ok]  ", color: GOOD },
  warn: { glyph: "!", ascii: "[warn]", color: WARN },
  fail: { glyph: "✗", ascii: "[fail]", color: BAD },
  skip: { glyph: "·", ascii: "[skip]", color: null },
};
const pretty = (p: string, home: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const note = (ctx: Ctx, status: Status, step: string, message: string): void => {
  ctx.report.steps.push({ step, status, message });
  if (status === "fail") ctx.report.ok = false;
  const m = MARKS[status];
  const mark = ctx.style.unicode ? (m.color ? ctx.style.paint(m.glyph, m.color) : ctx.style.dim(m.glyph)) : m.ascii;
  ctx.say(`  ${mark} ${ctx.style.bold(step.padEnd(13))} ${message}`);
};
const confirm = async (ctx: Ctx, question: string, def: boolean): Promise<boolean> => {
  if (ctx.auto) return def;
  const hint = def ? "[Y/n]" : "[y/N]";
  for (let i = 0; i < 3; i++) {
    const raw = await ctx.deps.io.ask(`  ${ctx.style.accent("?")} ${question} ${ctx.style.dim(hint)} `);
    if (raw === null) return false;
    const a = raw.trim().toLowerCase();
    if (a === "") return def;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
  return def;
};
const stepConfig = (ctx: Ctx): void => {
  const path = configPath();
  const shown = pretty(path, ctx.deps.home);
  const exists = existsSync(path);
  const { port } = ctx.opts;
  const cfg = ctx.report.config;
  cfg.path = path;
  const fresh = !exists || ctx.opts.force;
  const plan = (raw: string | null): string | null => {
    const base = fresh ? CONFIG_TEMPLATE : (raw ?? "");
    const next = port === null ? base : (planPort(base, port) ?? base);
    return fresh || next !== raw ? next : null;
  };
  const done = applyFile(path, plan, ctx.deps.now());
  cfg.backup = done.backup;
  if (done.action === "unchanged") {
    cfg.action = "kept";
    note(ctx, "ok", "Config", `${shown} already exists${port === null ? "" : ` and uses port ${port}`}, keeping it`);
  } else if (!fresh) {
    cfg.action = "updated";
    note(ctx, "ok", "Config", `set port ${port} in ${shown} (backup kept)`);
  } else {
    cfg.action = exists ? "replaced" : "created";
    note(ctx, "ok", "Config", exists ? `replaced ${shown} (backup kept)` : `created ${shown}`);
  }
};
const stepVibe = async (ctx: Ctx, store: Store): Promise<void> => {
  const linked = store.listAccounts().find((a) => a.keys.vibe === VIBE_REF);
  if (linked) {
    ctx.report.vibe_login = "linked";
    note(ctx, "ok", "Vibe login", `account '${linked.name}' already follows the Vibe CLI login`);
    return;
  }
  if (!ctx.deps.vibeKeyPresent()) {
    ctx.report.vibe_login = "missing";
    note(ctx, "warn", "Vibe login", "not found in the keyring; run `vibe --setup`, then `mistwatch import-vibe`");
    return;
  }
  if (!(await confirm(ctx, "Found a Vibe CLI login. Import it as an account?", true))) {
    ctx.report.vibe_login = "missing";
    note(ctx, "skip", "Vibe login", "not imported (run `mistwatch import-vibe` later)");
    return;
  }
  try {
    linkVibeLogin(store, "vibe-login");
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
    ctx.report.vibe_login = "failed";
    note(ctx, "fail", "Vibe login", e.message);
    return;
  }
  ctx.report.vibe_login = "imported";
  note(ctx, "ok", "Vibe login", "imported as account 'vibe-login'");
};
const stepToken = (ctx: Ctx, store: Store): void => {
  const existing = store.listApiKeys().length;
  const tok = ctx.report.client_token;
  tok.existing_keys = existing;
  if (existing > 0) {
    note(
      ctx,
      "ok",
      "Client token",
      `${existing === 1 ? "1 key already exists" : `${existing} keys already exist`}, not creating another`,
    );
    return;
  }
  if (ctx.opts.json && !ctx.opts.showToken) {
    tok.token = "skipped";
    tok.hint =
      "no client token created: --json without --show-token would lose it; add --show-token or run without --json";
    note(ctx, "skip", "Client token", "not created (--json without --show-token would lose it)");
    return;
  }
  const [, secret] = store.createApiKey("setup");
  ctx.newToken = secret;
  tok.created = true;
  tok.masked = mask(secret);
  if (ctx.opts.showToken) tok.token = secret;
  note(ctx, "ok", "Client token", `created key 'setup' (${tok.masked}), shown once below`);
};
const toHarness = (p: string): Harness | null => {
  const n = Number(p);
  const byNumber = Number.isInteger(n) ? HARNESSES[n - 1] : undefined;
  if (byNumber) return byNumber;
  const lower = p.toLowerCase();
  return isHarness(lower) ? lower : null;
};
export const parseChoice = (raw: string): Harness[] | null => {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.includes("all")) return [...HARNESSES];
  const picked = parts.map(toHarness);
  return parts.length > 0 && picked.every((h) => h !== null) ? HARNESSES.filter((h) => picked.includes(h)) : null;
};
const pickHarnesses = async (ctx: Ctx): Promise<Harness[]> => {
  if (ctx.opts.harness) return ctx.opts.harness;
  if (ctx.auto) return ["vibe"];
  const { io } = ctx.deps;
  io.out(`\n  ${ctx.style.accent("?")} Which tools should use Mistwatch?`);
  for (const [i, h] of HARNESSES.entries())
    io.out(`      ${i + 1}  ${TOOLS[h].label}${i === 0 ? ctx.style.dim("  (default)") : ""}`);
  for (let i = 0; i < 3; i++) {
    const a = ((await io.ask(`    Numbers or names, comma-separated, 'all', or Enter for the default: `)) ?? "").trim();
    if (a === "") return ["vibe"];
    const picked = parseChoice(a);
    if (picked) return picked;
    io.out(`    ${ctx.style.paint("Not understood.", BAD)}`);
  }
  return ["vibe"];
};
const HARNESS_PATHS = (deps: SetupDeps): Record<Harness, string> => ({
  vibe: join(deps.vibeHome, "config.toml"),
  opencode: opencodeConfigPath(deps.home, deps.platform),
  pi: join(deps.home, ".pi", "agent", "models.json"),
});
const stepHarness = (ctx: Ctx, h: Harness, cfg: Config): void => {
  const path = HARNESS_PATHS(ctx.deps)[h];
  const base = `http://${cfg.host}:${cfg.port}`;
  const label = TOOLS[h].label;
  const shown = pretty(path, ctx.deps.home);
  const result: HarnessResult = { harness: h, path, action: "failed", backup: null };
  ctx.report.harnesses.push(result);
  try {
    const plan = (raw: string | null): string | null =>
      h === "vibe" ? planToml(raw, base) : planJson(raw, h === "pi" ? pi(base) : opencode(base));
    const done = applyFile(path, plan, ctx.deps.now());
    result.action = done.action;
    result.backup = done.backup;
    const detail =
      done.action === "unchanged"
        ? `${shown} is already up to date`
        : `${done.action === "created" ? "wrote" : "updated"} ${shown}${done.backup ? ` (backup: ${pretty(done.backup, ctx.deps.home)})` : ""}`;
    note(ctx, "ok", label, detail);
  } catch (e) {
    note(ctx, "fail", label, `${shown}: ${errText(e)}`);
  }
};
const stepVerify = (ctx: Ctx, app: App): void => {
  const eng = createBudgetEngine(app.db, app.cfg.limits);
  const list = app.store.listAccounts();
  let pools = 0;
  for (const a of list) for (const p of POOLS) if (eng.status(a.name, p)) pools++;
  const accounts = list.length;
  ctx.report.status = { ok: true, accounts, pools_with_budget: pools };
  const tail =
    accounts === 0
      ? "no account yet, add one in the web UI"
      : `budgets load after the first sync (${pools} pools so far)`;
  note(ctx, "ok", "Status", `OK. ${accounts} account${accounts === 1 ? "" : "s"}; ${tail}`);
};
const tokenCommand = (platform: NodeJS.Platform): string =>
  platform === "win32"
    ? "setx MISTWATCH_TOKEN <token>   (then open a new terminal)"
    : "export MISTWATCH_TOKEN=<token>   (add it to your shell profile)";
const toolHint: Record<Harness, string> = {
  vibe: 'In Vibe, set provider = "mistwatch" on the models you use.',
  opencode: 'In OpenCode, pick a model of the "mistwatch" provider (start with auto).',
  pi: "In Pi, pick the mistwatch provider and the model auto.",
};
const summary = (ctx: Ctx, cfg: Config | null): string[] => {
  const { style, report } = ctx;
  const out: string[] = [];
  if (ctx.newToken) {
    out.push(
      "",
      `  ${style.accent("Client token")} ${style.dim("(shown once, copy it now)")}`,
      `    ${ctx.newToken}`,
      "",
    );
    out.push(`  ${style.accent("Make it available to your tools")}`, `    ${tokenCommand(ctx.deps.platform)}`);
  } else if (report.client_token.existing_keys > 0) {
    out.push("", `  Use one of your existing keys as ${ENV}, or create another under "API keys" in the web UI.`);
  }
  out.push("", `  ${style.accent("Next steps")}`);
  const url = cfg ? `http://${cfg.host}:${cfg.port}/` : "http://127.0.0.1:8787/";
  if (report.vibe_login === "missing")
    out.push("    - Run `vibe --setup`, then `mistwatch import-vibe` (or add a key in the web UI).");
  out.push(`    - Start the proxy: mistwatch serve   (web UI: ${url})`);
  for (const h of report.harnesses) if (h.action !== "failed") out.push(`    - ${toolHint[h.harness]}`);
  return out;
};
const startNow = async (ctx: Ctx, cfg: Config): Promise<void> => {
  try {
    await ctx.deps.start(cfg);
    ctx.report.started = true;
  } catch (e) {
    note(ctx, "fail", "Serve", errText(e));
  }
};
export const runSetup = async (args: string[], deps: SetupDeps): Promise<number> => {
  const { io } = deps;
  let opts: SetupOptions;
  try {
    opts = parseSetupArgs(args);
  } catch (e) {
    if (!(e instanceof SetupArgError)) throw e;
    io.err(`mistwatch: ${e.message}`);
    io.err("usage: mistwatch setup [--yes] [--harness vibe,opencode,pi] [--port N] [--no-banner] [--start] [--json]");
    return 2;
  }
  if (opts.help) {
    io.out(SETUP_USAGE);
    return 0;
  }
  const style = createStyle(io.depth);
  const ctx: Ctx = {
    deps,
    opts,
    style,
    auto: opts.yes || opts.json || !io.interactive,
    report: {
      ok: true,
      steps: [],
      config: { path: configPath(), action: "failed", backup: null },
      vibe_login: "missing",
      client_token: { created: false, existing_keys: 0, masked: null },
      harnesses: [],
      status: null,
      started: false,
    },
    newToken: null,
    say: (line) => {
      if (!opts.json) io.out(line);
    },
  };
  let cfg: Config | null = null;
  if (!opts.noBanner) ctx.say(`${banner(style, "Budget-aware proxy for Mistral").join("\n")}\n`);
  let app: App | null = null;
  try {
    stepConfig(ctx);
    app = openApp();
    cfg = app.cfg;
    await stepVibe(ctx, app.store);
    const picked = await pickHarnesses(ctx);
    stepToken(ctx, app.store);
    for (const h of picked) stepHarness(ctx, h, app.cfg);
    stepVerify(ctx, app);
  } catch (e) {
    note(ctx, "fail", "Setup", errText(e));
  } finally {
    app?.db.close();
  }
  for (const line of summary(ctx, cfg)) ctx.say(line);
  if (ctx.report.ok && cfg) {
    if (!opts.start && !ctx.auto) ctx.say("");
    if (opts.start || (!ctx.auto && (await confirm(ctx, "Start Mistwatch now?", true)))) {
      io.close();
      await startNow(ctx, cfg);
    }
  }
  io.close();
  const failed = ctx.report.steps.find((s) => s.status === "fail");
  if (opts.json) io.out(JSON.stringify(ctx.report, null, 2));
  if (failed) io.err(`mistwatch: setup failed: ${failed.step}: ${failed.message}`);
  return ctx.report.ok ? 0 : 1;
};
export const createAsk = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Pick<SetupIo, "ask" | "close"> => {
  let rl: Interface | null = null;
  let eof = false;
  return {
    ask: async (question) => {
      if (eof) return null;
      if (!rl) {
        const { createInterface } = await import("node:readline/promises");
        const created = createInterface({ input, output });
        rl = created;
        created.on("SIGINT", () => {
          output.write("\n");
          process.exit(130);
        });
        created.once("close", () => {
          if (rl !== created) return;
          rl = null;
          eof = true;
        });
      }
      const r = rl;
      const closed = new Promise<null>((res) => r.once("close", () => res(null)));
      return Promise.race([r.question(question).catch(() => null), closed]);
    },
    close: () => {
      const r = rl;
      rl = null;
      r?.close();
    },
  };
};
export const defaultSetupDeps = (): SetupDeps => {
  const tty = Boolean(process.stdout.isTTY);
  const home = homedir();
  const probe = (env: NodeJS.ProcessEnv): number =>
    process.stdout instanceof WriteStream ? process.stdout.getColorDepth(env) : 1;
  return {
    io: {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
      ...createAsk(),
      interactive: Boolean(process.stdin.isTTY) && tty,
      depth: detectDepth(process.env, tty, probe),
    },
    home,
    vibeHome: process.env.VIBE_HOME || join(home, ".vibe"),
    platform: process.platform,
    now: () => new Date(),
    vibeKeyPresent: () => vibeCliKeyPresent(),
    start: async (cfg) => (await import("./app.ts")).startServer(cfg),
  };
};
