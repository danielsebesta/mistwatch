import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vibe } from "../src/agents.ts";
import { linkVibeLogin, openApp } from "../src/open.ts";
import {
  banner,
  type ColorDepth,
  createAsk,
  createStyle,
  detectDepth,
  parseChoice,
  parseHarnesses,
  parseSetupArgs,
  parseUrl,
  planJson,
  planPort,
  planToml,
  runSetup,
  SetupArgError,
  type SetupDeps,
} from "../src/setup.ts";
import { VIBE_REF } from "../src/store.ts";
import type { Config } from "../src/types.ts";

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return { ...orig, renameSync: vi.fn(orig.renameSync) };
});

process.env.MISTWATCH_NO_KEYRING = "1";

const BASE = "http://127.0.0.1:8787";
const NOW = new Date(Date.UTC(2026, 10, 18, 10, 15, 0));
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TOKEN_RE = /mw-[A-Za-z0-9_-]{20,}/g;
let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["MISTWATCH_HOME", "MISTWATCH_CONFIG", "HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
const setEnv = (k: string, v: string | undefined): void => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
type Harnessed = {
  deps: SetupDeps;
  out: string[];
  err: string[];
  asked: string[];
  started: Config[];
};
const make = (
  opts: {
    answers?: string[];
    interactive?: boolean;
    depth?: ColorDepth;
    vibeKey?: boolean;
    platform?: NodeJS.Platform;
    installed?: string[];
    fetch?: SetupDeps["fetch"];
    secret?: SetupDeps["secret"];
    setx?: SetupDeps["setx"];
    env?: NodeJS.ProcessEnv;
  } = {},
): Harnessed => {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const started: Config[] = [];
  const answers = [...(opts.answers ?? [])];
  const deps: SetupDeps = {
    io: {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      ask: async (q) => {
        asked.push(q);
        return answers.shift() ?? null;
      },
      close: () => undefined,
      interactive: opts.interactive ?? false,
      depth: opts.depth ?? 0,
    },
    home,
    vibeHome: join(home, ".vibe"),
    platform: opts.platform ?? "linux",
    now: () => NOW,
    vibeKeyPresent: () => opts.vibeKey ?? true,
    start: async (cfg) => {
      started.push(cfg);
    },
    which: (c) => (opts.installed ?? ["vibe", "opencode", "pi"]).includes(c),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.secret ? { secret: opts.secret } : {}),
    ...(opts.setx ? { setx: opts.setx } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  };
  return { deps, out, err, asked, started };
};
const text = (h: Harnessed): string => h.out.join("\n");
const paths = () => ({
  cfg: join(root, "mw", "config.toml"),
  vibe: join(home, ".vibe", "config.toml"),
  opencode: join(home, ".config", "opencode", "opencode.json"),
  pi: join(home, ".pi", "agent", "models.json"),
});
const put = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
};
const backups = (path: string): string[] =>
  existsSync(dirname(path)) ? readdirSync(dirname(path)).filter((f) => f.endsWith(".bak")) : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mw-setup-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setEnv("MISTWATCH_HOME", join(root, "mw"));
  setEnv("MISTWATCH_CONFIG", undefined);
  setEnv("HOME", home);
  setEnv("USERPROFILE", home);
  setEnv("XDG_CONFIG_HOME", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) setEnv(k, saved[k]);
  rmSync(root, { recursive: true, force: true });
});

describe("setup flag parsing", () => {
  it("has quiet, non-destructive defaults", () => {
    expect(parseSetupArgs([])).toEqual({
      yes: false,
      harness: null,
      port: null,
      url: null,
      noBanner: false,
      start: false,
      json: false,
      showToken: false,
      force: false,
      help: false,
    });
  });
  it("reads every flag", () => {
    const o = parseSetupArgs(["-y", "--harness", "pi,vibe,pi", "--no-banner", "--json", "--show-token", "--force"]);
    expect(o).toMatchObject({
      yes: true,
      harness: ["vibe", "pi"],
      noBanner: true,
      start: false,
      json: true,
      showToken: true,
      force: true,
    });
    expect(parseSetupArgs(["--harness=all"]).harness).toEqual(["vibe", "opencode", "pi"]);
  });
  it("rejects unknown harnesses, empty lists and unknown flags", () => {
    expect(() => parseHarnesses("vibe,emacs")).toThrow(SetupArgError);
    expect(() => parseHarnesses("")).toThrow("--harness expects");
    expect(() => parseSetupArgs(["--bogus"])).toThrow(SetupArgError);
    expect(() => parseSetupArgs(["--harness"])).toThrow(SetupArgError);
    expect(() => parseSetupArgs(["--json", "--start"])).toThrow("cannot be combined");
    for (const bad of ["0", "65536", "80x", "", "-1", "1.5"])
      expect(() => parseSetupArgs([`--port=${bad}`])).toThrow("--port expects");
    expect(parseSetupArgs(["--port", "9100"]).port).toBe(9100);
  });
  it("understands numbers, names and all in the prompt", () => {
    expect(parseChoice("1")).toEqual(["vibe"]);
    expect(parseChoice("3, opencode")).toEqual(["opencode", "pi"]);
    expect(parseChoice("all")).toEqual(["vibe", "opencode", "pi"]);
    expect(parseChoice("7")).toBeNull();
    expect(parseChoice("1 emacs")).toBeNull();
  });
  it("exits 2 with a message on bad flags and 0 on --help", async () => {
    const bad = make();
    expect(await runSetup(["--harness", "emacs"], bad.deps)).toBe(2);
    expect(bad.err.join("\n")).toContain("--harness expects");
    expect(existsSync(paths().cfg)).toBe(false);
    const help = make();
    expect(await runSetup(["--help"], help.deps)).toBe(0);
    expect(text(help)).toContain("usage: mistwatch setup");
  });
});

describe("setup banner", () => {
  it("is plain ASCII without colour", () => {
    const lines = banner(createStyle(0), "Budget-aware proxy for Mistral");
    const all = lines.join("\n");
    expect(lines).toHaveLength(5);
    expect([...all].every((ch) => ch === "\n" || (ch >= " " && ch <= "~"))).toBe(true);
    expect(all).toContain("##");
    expect(all).toContain("mistwatch");
  });
  it("uses half blocks and the seed colour in truecolor, and degrades", () => {
    const rich = banner(createStyle(24), "x").join("\n");
    expect(rich).toContain("▀");
    expect(rich).toContain("▄");
    expect(rich).toContain("█");
    expect(rich).toContain("\x1b[38;2;255;130;4m");
    expect(banner(createStyle(8), "x").join("\n")).toContain("\x1b[38;5;");
    const basic = banner(createStyle(4), "x").join("\n");
    expect(basic).not.toContain("38;5;");
    expect(basic).not.toContain("38;2;");
    expect(basic).toContain("\x1b[93m");
  });
  it("picks the colour depth from the terminal and NO_COLOR", () => {
    const deep = () => 24;
    expect(detectDepth({}, true, deep)).toBe(24);
    expect(detectDepth({ NO_COLOR: "1" }, true, deep)).toBe(0);
    expect(detectDepth({}, false, deep)).toBe(0);
    expect(detectDepth({ TERM: "dumb" }, true, deep)).toBe(0);
    expect(detectDepth({}, true, () => 8)).toBe(8);
    expect(detectDepth({}, true, () => 4)).toBe(4);
    expect(detectDepth({}, true, () => 1)).toBe(0);
  });
  it("prints a colourless banner in a run and none with --no-banner or --json", async () => {
    const a = make();
    await runSetup(["--yes"], a.deps);
    expect(text(a)).toContain("mistwatch");
    expect(text(a)).not.toContain("\x1b");
    const b = make();
    await runSetup(["--yes", "--no-banner"], b.deps);
    expect(text(b)).not.toContain("Budget-aware");
    const c = make();
    await runSetup(["--yes", "--json"], c.deps);
    expect(text(c).trimStart().startsWith("{")).toBe(true);
  });
});

describe("setup non-interactive flow", () => {
  it("sets everything up with defaults and prints the token once", async () => {
    const h = make();
    expect(await runSetup(["--yes"], h.deps)).toBe(0);
    const p = paths();
    expect(readFileSync(p.cfg, "utf8")).toContain("port = 8787");
    const toml = parse(readFileSync(p.vibe, "utf8"));
    expect(toml.providers).toEqual([
      { name: "mistwatch", api_base: `${BASE}/v1`, api_key_env_var: "MISTWATCH_TOKEN", backend: "mistral" },
    ]);
    expect(existsSync(p.opencode)).toBe(false);
    expect(existsSync(p.pi)).toBe(false);
    expect(h.asked).toEqual([]);
    expect(h.started).toEqual([]);
    const tokens = text(h).match(TOKEN_RE) ?? [];
    expect(tokens).toHaveLength(1);
    expect(text(h)).toContain(`${tokens[0]?.slice(0, 5)}…`);
    expect(text(h)).toContain("[ok]");
    expect(text(h)).toContain("Status");
    expect(text(h)).toContain("export MISTWATCH_TOKEN=<token>");
    expect(text(h)).toContain("imported as account 'vibe-login'");
  });
  it("never overwrites an existing vibe-login account with its own key", async () => {
    expect(await runSetup(["--yes", "--no-banner"], make({ vibeKey: false }).deps)).toBe(0);
    const app = openApp();
    app.store.createAccount("vibe-login");
    app.store.setKey("vibe-login", "vibe", { value: "own-secret-key" });
    const own = app.store.getAccount("vibe-login")?.keys.vibe;
    app.db.close();
    const h = make();
    expect(await runSetup(["--yes", "--no-banner"], h.deps)).toBe(0);
    expect(text(h)).toContain("imported as account 'vibe-login-2'");
    const after = openApp();
    expect(after.store.getAccount("vibe-login")?.keys.vibe).toBe(own);
    expect(after.store.getAccount("vibe-login-2")?.keys.vibe).toBe(VIBE_REF);
    expect(() => linkVibeLogin(after.store, "vibe-login")).toThrow("already has its own Vibe key");
    expect(after.store.getAccount("vibe-login")?.keys.vibe).toBe(own);
    after.db.close();
  });
  it("shows the Windows variable command on win32", async () => {
    const h = make({ platform: "win32" });
    await runSetup(["--yes", "--no-banner"], h.deps);
    expect(text(h)).toContain("setx MISTWATCH_TOKEN <token>");
  });
  it("honors MISTWATCH_CONFIG and a missing Vibe login", async () => {
    const custom = join(root, "elsewhere", "my.toml");
    setEnv("MISTWATCH_CONFIG", custom);
    const h = make({ vibeKey: false });
    expect(await runSetup(["--yes"], h.deps)).toBe(0);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(paths().cfg)).toBe(false);
    expect(text(h)).toContain("[warn]");
    expect(text(h)).toContain("vibe --setup");
  });
  it("writes the chosen harnesses", async () => {
    const h = make();
    expect(await runSetup(["--yes", "--harness", "vibe,opencode,pi"], h.deps)).toBe(0);
    const p = paths();
    const oc: unknown = JSON.parse(readFileSync(p.opencode, "utf8"));
    expect(isRec(oc) && isRec(oc.provider) && "mistwatch" in oc.provider).toBe(true);
    const pi: unknown = JSON.parse(readFileSync(p.pi, "utf8"));
    expect(isRec(pi) && isRec(pi.providers) && "mistwatch" in pi.providers).toBe(true);
    expect(existsSync(p.vibe)).toBe(true);
  });
  it("never starts the server unless --start, then starts it with the config", async () => {
    const a = make();
    await runSetup(["--yes"], a.deps);
    expect(a.started).toHaveLength(0);
    const b = make();
    expect(await runSetup(["--yes", "--start"], b.deps)).toBe(0);
    expect(b.started).toHaveLength(1);
    expect(b.started[0]?.port).toBe(8787);
  });
  it("is non-interactive when stdin is not a terminal even without --yes", async () => {
    const h = make({ interactive: false, answers: ["2"] });
    expect(await runSetup([], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(existsSync(paths().vibe)).toBe(true);
    expect(existsSync(paths().opencode)).toBe(false);
  });
  it("fails with a clear message and non-zero exit when a config file is unusable", async () => {
    const p = paths();
    put(p.opencode, "{ // comments\n}");
    const h = make();
    expect(await runSetup(["--yes", "--harness", "opencode,vibe"], h.deps)).toBe(1);
    expect(readFileSync(p.opencode, "utf8")).toBe("{ // comments\n}");
    expect(backups(p.opencode)).toEqual([]);
    expect(existsSync(p.vibe)).toBe(true);
    expect(text(h)).toContain("[fail]");
    expect(h.err.join("\n")).toContain("setup failed: OpenCode");
  });
  it("fails when the existing config.toml cannot be loaded", async () => {
    put(paths().cfg, "port = [");
    const h = make();
    expect(await runSetup(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("setup failed");
    expect(existsSync(paths().vibe)).toBe(false);
  });
  it("does not start the server after a failure", async () => {
    put(paths().pi, "[1]");
    const h = make();
    expect(await runSetup(["--yes", "--harness", "pi", "--start"], h.deps)).toBe(1);
    expect(h.started).toEqual([]);
  });
});

describe("setup json output", () => {
  it("creates no key without --show-token, so no token is lost", async () => {
    const h = make();
    expect(await runSetup(["--yes", "--json"], h.deps)).toBe(0);
    const raw = text(h);
    expect(raw).not.toMatch(TOKEN_RE);
    const d: unknown = JSON.parse(raw);
    expect(isRec(d) ? d.ok : null).toBe(true);
    const tok = isRec(d) && isRec(d.client_token) ? d.client_token : {};
    expect(tok.created).toBe(false);
    expect(tok.token).toBe("skipped");
    expect(String(tok.hint)).toContain("--show-token");
    const harnesses = isRec(d) && Array.isArray(d.harnesses) ? d.harnesses : [];
    expect(harnesses).toHaveLength(1);
    const next = make();
    await runSetup(["--yes", "--no-banner"], next.deps);
    expect(text(next).match(TOKEN_RE) ?? []).toHaveLength(1);
    expect(text(next)).not.toContain("key already exist");
  });
  it("includes the token with --show-token and reports failures as ok: false", async () => {
    const h = make();
    await runSetup(["--yes", "--json", "--show-token"], h.deps);
    const d: unknown = JSON.parse(text(h));
    const tok = isRec(d) && isRec(d.client_token) ? d.client_token : {};
    expect(tok.created).toBe(true);
    expect(String(tok.token)).toMatch(TOKEN_RE);
    put(paths().pi, "nope");
    const f = make();
    expect(await runSetup(["--yes", "--json", "--harness", "pi"], f.deps)).toBe(1);
    const e: unknown = JSON.parse(text(f));
    expect(isRec(e) ? e.ok : null).toBe(false);
  });
});

describe("setup backups, merging and idempotency", () => {
  it("backs up an existing opencode config with a timestamp and merges into it", async () => {
    const p = paths();
    const before = JSON.stringify({ theme: "dark", provider: { other: { a: 1 } } });
    put(p.opencode, before);
    const h = make();
    expect(await runSetup(["--yes", "--harness", "opencode"], h.deps)).toBe(0);
    const files = backups(p.opencode);
    expect(files).toEqual(["opencode.json.20261118T101500Z.bak"]);
    expect(readFileSync(`${p.opencode}.20261118T101500Z.bak`, "utf8")).toBe(before);
    const d: unknown = JSON.parse(readFileSync(p.opencode, "utf8"));
    const prov = isRec(d) && isRec(d.provider) ? d.provider : {};
    expect(isRec(d) ? d.theme : null).toBe("dark");
    expect(prov.other).toEqual({ a: 1 });
    expect("mistwatch" in prov).toBe(true);
    expect(text(h)).toContain("backup:");
  });
  it("appends the vibe provider to an existing config.toml and keeps the rest", async () => {
    const p = paths();
    const before = 'active_model = "x"\n\n[[providers]]\nname = "mistral"\napi_base = "https://api.mistral.ai/v1"\n';
    put(p.vibe, before);
    const h = make();
    expect(await runSetup(["--yes"], h.deps)).toBe(0);
    expect(backups(p.vibe)).toHaveLength(1);
    const next = readFileSync(p.vibe, "utf8");
    expect(next.startsWith(before.trimEnd())).toBe(true);
    const doc = parse(next);
    expect(doc.active_model).toBe("x");
    const names = Array.isArray(doc.providers) ? doc.providers.map((x) => (isRec(x) ? x.name : null)) : [];
    expect(names).toEqual(["mistral", "mistwatch"]);
  });
  it("keeps a unique backup per run when the clock does not move", async () => {
    const p = paths();
    put(p.pi, "{}");
    await runSetup(["--yes", "--harness", "pi"], make().deps);
    put(p.pi, '{"x":1}');
    await runSetup(["--yes", "--harness", "pi"], make().deps);
    expect(backups(p.pi).sort()).toEqual(["models.json.20261118T101500Z-1.bak", "models.json.20261118T101500Z.bak"]);
  });
  it("is idempotent: a second run changes nothing and creates no backups or tokens", async () => {
    const p = paths();
    await runSetup(["--yes", "--harness", "vibe,opencode,pi"], make().deps);
    const snap = [p.cfg, p.vibe, p.opencode, p.pi].map((f) => readFileSync(f, "utf8"));
    const h = make();
    expect(await runSetup(["--yes", "--harness", "vibe,opencode,pi"], h.deps)).toBe(0);
    expect([p.cfg, p.vibe, p.opencode, p.pi].map((f) => readFileSync(f, "utf8"))).toEqual(snap);
    for (const f of [p.cfg, p.vibe, p.opencode, p.pi]) expect(backups(f)).toEqual([]);
    expect(text(h)).not.toMatch(TOKEN_RE);
    expect(text(h)).toContain("already up to date");
    expect(text(h)).toContain("already exists, keeping it");
    expect(text(h)).toContain("1 key already exists");
  });
  it("only replaces config.toml with --force, and backs it up first", async () => {
    const p = paths();
    put(p.cfg, "# mine\n[server]\nport = 9999\n");
    await runSetup(["--yes"], make().deps);
    expect(readFileSync(p.cfg, "utf8")).toContain("port = 9999");
    const h = make();
    expect(await runSetup(["--yes", "--force"], h.deps)).toBe(0);
    expect(readFileSync(p.cfg, "utf8")).toContain("port = 8787");
    const [bak] = backups(p.cfg);
    expect(readFileSync(join(dirname(p.cfg), bak ?? ""), "utf8")).toContain("port = 9999");
  });
  it("uses the configured port in the generated provider", async () => {
    put(paths().cfg, "[server]\nport = 9100\n");
    await runSetup(["--yes", "--harness", "opencode"], make().deps);
    expect(readFileSync(paths().opencode, "utf8")).toContain("http://127.0.0.1:9100/v1");
  });
});

describe("harness planners", () => {
  const data = { provider: { mistwatch: { a: 1 } } };
  it("merges json without touching siblings and reports no change when equal", () => {
    const raw = JSON.stringify({ keep: true, provider: { other: 1 } });
    const next = planJson(raw, data);
    expect(JSON.parse(next ?? "{}")).toEqual({ keep: true, provider: { other: 1, mistwatch: { a: 1 } } });
    expect(planJson(next, data)).toBeNull();
    expect(JSON.parse(planJson(null, data) ?? "{}")).toEqual(data);
    expect(JSON.parse(planJson("  \n", data) ?? "{}")).toEqual(data);
    expect(JSON.parse(planJson(`﻿${raw}`, data) ?? "{}")).toMatchObject({ keep: true });
  });
  it("refuses json that is not a plain object", () => {
    expect(() => planJson("{ // c\n}", data)).toThrow("not plain JSON");
    expect(() => planJson("[1]", data)).toThrow("not a JSON object");
  });
  it("creates, keeps and replaces the toml provider block", () => {
    expect(planToml(null, BASE)).toBe(vibe(BASE));
    const ok = `${vibe(BASE)}\n[[models]]\nname = "m"\n`;
    expect(planToml(ok, BASE)).toBeNull();
    const old =
      '[[providers]]\nname = "a"\n\n[[providers]]\nname = "mistwatch"\napi_base = "http://127.0.0.1:1/v1"\n\n[[models]]\nname = "m"\n';
    const next = planToml(old, BASE) ?? "";
    const doc = parse(next);
    const list = Array.isArray(doc.providers) ? doc.providers : [];
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ name: "mistwatch", api_base: `${BASE}/v1` });
    expect(Array.isArray(doc.models) ? doc.models : []).toHaveLength(2);
  });
  it("replaces every stale mistwatch block and keeps the custom fields of the first", () => {
    const old =
      '[[providers]]\nname = "mistwatch"\napi_base = "http://127.0.0.1:1/v1"\nextra = "keep"\n\n' +
      '[[providers]] # second\nname = "mistwatch"\napi_base = "http://127.0.0.1:2/v1"\n\n[[models]]\nname = "m"\n';
    const doc = parse(planToml(old, BASE) ?? "");
    const list = Array.isArray(doc.providers) ? doc.providers : [];
    expect(list).toEqual([
      {
        name: "mistwatch",
        api_base: `${BASE}/v1`,
        api_key_env_var: "MISTWATCH_TOKEN",
        backend: "mistral",
        extra: "keep",
      },
    ]);
    expect(Array.isArray(doc.models) ? doc.models : []).toHaveLength(2);
  });
  it("does not report ok while a second mistwatch block is stale", () => {
    const stale = `${vibe(BASE)}\n[[providers]]\nname = "mistwatch"\napi_base = "http://127.0.0.1:1/v1"\n`;
    const next = planToml(stale, BASE) ?? "";
    const list = parse(next).providers;
    expect(Array.isArray(list) ? list : []).toHaveLength(1);
    expect(planToml(next, BASE)).toBeNull();
  });
  it("keeps CRLF line endings and rejects broken toml", () => {
    const next = planToml('[[providers]]\r\nname = "a"\r\n', BASE) ?? "";
    expect(next).toContain('name = "mistwatch"\r\n');
    expect(next.replace(/\r\n/g, "")).not.toContain("\n");
    expect(() => planToml("a = [", BASE)).toThrow("not valid TOML");
  });
});

describe("setup prompts", () => {
  it("asks about the Vibe login, the tools and whether to start", async () => {
    const h = make({ interactive: true, answers: ["", "", "2,3", "n", "n"] });
    expect(await runSetup([], h.deps)).toBe(0);
    expect(h.asked).toHaveLength(5);
    expect(text(h)).toContain("Where does Mistwatch run?");
    expect(h.asked[1]).toContain("Import it as an account?");
    expect(existsSync(paths().vibe)).toBe(false);
    expect(existsSync(paths().opencode)).toBe(true);
    expect(existsSync(paths().pi)).toBe(true);
    expect(h.started).toEqual([]);
    expect(text(h)).toContain("1  Vibe CLI");
  });
  it("starts the server when the user agrees and skips the tool question with --harness", async () => {
    const h = make({ interactive: true, answers: ["", "y", "n", "y"] });
    expect(await runSetup(["--harness", "vibe"], h.deps)).toBe(0);
    expect(h.asked).toHaveLength(4);
    expect(h.started).toHaveLength(1);
  });
  it("can decline the Vibe import and re-asks on unclear answers", async () => {
    const h = make({ interactive: true, answers: ["", "n", "9", "1", "n"] });
    expect(await runSetup([], h.deps)).toBe(0);
    expect(text(h)).toContain("not imported");
    expect(text(h)).toContain("Not understood.");
    expect(existsSync(paths().vibe)).toBe(true);
  });
  it("declines questions but keeps the default tool when input ends", async () => {
    const h = make({ interactive: true, answers: [] });
    expect(await runSetup([], h.deps)).toBe(0);
    expect(text(h)).toContain("not imported");
    expect(existsSync(paths().vibe)).toBe(true);
    expect(h.started).toEqual([]);
  });
});

describe("setup --port", () => {
  it("writes the port into a new config.toml and the harness URLs", async () => {
    const h = make();
    expect(await runSetup(["--yes", "--harness", "vibe,opencode,pi", "--port", "9200", "--start"], h.deps)).toBe(0);
    const p = paths();
    expect(readFileSync(p.cfg, "utf8")).toContain("port = 9200");
    expect(backups(p.cfg)).toEqual([]);
    for (const f of [p.vibe, p.opencode, p.pi]) expect(readFileSync(f, "utf8")).toContain("http://127.0.0.1:9200/v1");
    expect(h.started[0]?.port).toBe(9200);
  });
  it("changes the port of an existing config with a backup and is idempotent", async () => {
    const p = paths();
    put(p.cfg, '# mine\n[server]\nhost = "127.0.0.1"\nport = 8787 # default\n\n[limits]\nreserve_pct = 5\n');
    const h = make();
    expect(await runSetup(["--yes", "--port", "9300"], h.deps)).toBe(0);
    const next = readFileSync(p.cfg, "utf8");
    expect(next).toContain("port = 9300 # default");
    expect(next).toContain("reserve_pct = 5");
    expect(backups(p.cfg)).toHaveLength(1);
    expect(readFileSync(p.vibe, "utf8")).toContain("http://127.0.0.1:9300/v1");
    const again = make();
    expect(await runSetup(["--yes", "--port", "9300"], again.deps)).toBe(0);
    expect(backups(p.cfg)).toHaveLength(1);
    expect(text(again)).toContain("uses port 9300");
  });
  it("edits toml without a port line or server table", () => {
    expect(parse(planPort('[server]\nhost = "x"\n', 9000) ?? "")).toMatchObject({ server: { host: "x", port: 9000 } });
    expect(parse(planPort("[limits]\na = 1\n", 9000) ?? "")).toMatchObject({
      server: { port: 9000 },
      limits: { a: 1 },
    });
    expect(parse(planPort("", 9000) ?? "")).toEqual({ server: { port: 9000 } });
    expect(planPort("[server]\nport = 9000\n", 9000)).toBeNull();
    expect(planPort("[server]\r\nport = 1\r\n", 9000)).toBe("[server]\r\nport = 9000\r\n");
    expect(() => planPort("a = [", 9000)).toThrow("not valid TOML");
    expect(() => planPort('server = { host = "x" }\n', 9000)).toThrow("edit it by hand");
    expect(() => planPort('[server]\nport = "8787"\n', 9000)).toThrow("edit it by hand");
  });
});

describe("setup token and prompt robustness", () => {
  it("asks which tools to use before it creates the key", async () => {
    const h = make({ interactive: true, answers: ["", "n", "1", "n"] });
    const ask = h.deps.io.ask;
    let keysWhenAsked = -1;
    h.deps.io.ask = async (q) => {
      if (q.includes("Numbers or names")) keysWhenAsked = (text(h).match(/created key/g) ?? []).length;
      return ask(q);
    };
    await runSetup(["--no-banner"], h.deps);
    expect(keysWhenAsked).toBe(0);
    expect(text(h)).toMatch(TOKEN_RE);
  });
  it("keeps the flow going when input ends at every prompt", async () => {
    const h = make({ interactive: true });
    expect(await runSetup(["--no-banner"], h.deps)).toBe(0);
    expect(text(h)).toMatch(TOKEN_RE);
    expect(h.err).toEqual([]);
  });
  it("createAsk returns null after end of input instead of throwing", async () => {
    const input = new PassThrough();
    const a = createAsk(input, new PassThrough());
    const first = a.ask("one? ");
    input.write("hello\n");
    expect(await first).toBe("hello");
    const second = a.ask("two? ");
    input.end();
    expect(await second).toBeNull();
    expect(await a.ask("three? ")).toBeNull();
    expect(await a.ask("four? ")).toBeNull();
    a.close();
  });
});

describe("setup file writes", () => {
  const tmpLeft = (path: string): string[] => readdirSync(dirname(path)).filter((f) => f.includes("mistwatch-tmp"));
  it("removes the temp file and the new backup when the rename fails", async () => {
    const p = paths();
    put(p.pi, '{"x":1}');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    });
    const h = make();
    expect(await runSetup(["--yes", "--harness", "pi"], h.deps)).toBe(1);
    expect(text(h)).toContain("EPERM");
    expect(readFileSync(p.pi, "utf8")).toBe('{"x":1}');
    expect(tmpLeft(p.pi)).toEqual([]);
    expect(backups(p.pi)).toEqual([]);
    expect(await runSetup(["--yes", "--harness", "pi"], make().deps)).toBe(0);
    expect(backups(p.pi)).toHaveLength(1);
  });
  it.skipIf(process.platform === "win32")("keeps the file mode of an existing config", async () => {
    const p = paths();
    put(p.pi, "{}");
    chmodSync(p.pi, 0o600);
    await runSetup(["--yes", "--harness", "pi"], make().deps);
    expect(statSync(p.pi).mode & 0o777).toBe(0o600);
  });
  it("writes through a symlink and leaves the link in place", async () => {
    const p = paths();
    const real = join(root, "dotfiles", "models.json");
    put(real, "{}");
    mkdirSync(dirname(p.pi), { recursive: true });
    try {
      symlinkSync(real, p.pi);
    } catch {
      return;
    }
    expect(await runSetup(["--yes", "--harness", "pi"], make().deps)).toBe(0);
    expect(realpathSync(p.pi)).toBe(realpathSync(real));
    expect(readFileSync(real, "utf8")).toContain("mistwatch");
    expect(tmpLeft(real)).toEqual([]);
  });
  it("creates the target of a dangling symlink", async () => {
    const p = paths();
    const real = join(root, "dotfiles", "models.json");
    mkdirSync(dirname(p.pi), { recursive: true });
    mkdirSync(dirname(real), { recursive: true });
    try {
      symlinkSync(real, p.pi);
    } catch {
      return;
    }
    expect(await runSetup(["--yes", "--harness", "pi"], make().deps)).toBe(0);
    expect(readFileSync(real, "utf8")).toContain("mistwatch");
  });
});

describe("opencode config location", () => {
  it("honours XDG_CONFIG_HOME on non-Windows and falls back to ~/.config", async () => {
    const xdg = join(root, "xdg");
    setEnv("XDG_CONFIG_HOME", xdg);
    expect(await runSetup(["--yes", "--harness", "opencode"], make().deps)).toBe(0);
    expect(existsSync(join(xdg, "opencode", "opencode.json"))).toBe(true);
    expect(existsSync(paths().opencode)).toBe(false);
  });
  it("ignores a relative XDG_CONFIG_HOME and the variable on win32", async () => {
    setEnv("XDG_CONFIG_HOME", "relative/dir");
    await runSetup(["--yes", "--harness", "opencode"], make().deps);
    expect(existsSync(paths().opencode)).toBe(true);
    rmSync(paths().opencode);
    setEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    await runSetup(["--yes", "--harness", "opencode"], make({ platform: "win32" }).deps);
    expect(existsSync(paths().opencode)).toBe(true);
    expect(existsSync(join(root, "xdg"))).toBe(false);
  });
});
describe("parseUrl", () => {
  it("accepts a server address and drops /v1 and slashes", () => {
    expect(parseUrl(undefined)).toBeNull();
    expect(parseUrl("http://100.96.35.29:8787/")).toBe("http://100.96.35.29:8787");
    expect(parseUrl("https://mw.example.com/v1")).toBe("https://mw.example.com");
  });
  it("rejects other schemes, credentials and paths", () => {
    for (const bad of ["ftp://x", "http://u:p@x", "http://x/foo", "http://x/?a=1", "nope"])
      expect(() => parseUrl(bad)).toThrow(SetupArgError);
  });
});
describe("planToml auto model", () => {
  const find = (text: string) =>
    ((parse(text).models as Record<string, unknown>[]) ?? []).filter((m) => m.name === "auto");
  it("adds an auto model to an existing config, once", () => {
    const raw = '[[models]]\nname = "x"\nprovider = "mistral"\nalias = "x"\n';
    const once = planToml(raw, "http://h:1") ?? "";
    expect(find(once)).toMatchObject([{ provider: "mistwatch", alias: "auto" }]);
    expect(planToml(once, "http://h:1")).toBeNull();
  });
  it("adds it when only the provider exists", () => {
    const raw = planToml("", "http://h:1") ?? "";
    const noModel = raw.replace(/\[\[models\]\][\s\S]*$/, "");
    expect(find(planToml(noModel, "http://h:1") ?? "")).toHaveLength(1);
  });
});
describe("planToml allowed_models", () => {
  const list = (t: string) => parse(t).allowed_models;
  it("adds auto to a multi-line allowlist, once", () => {
    const raw = 'allowed_models = [\n    "a",\n    "b",\n]\n';
    const out = planToml(raw, "http://h:1") ?? "";
    expect(list(out)).toEqual(["auto", "a", "b"]);
    expect(planToml(out, "http://h:1")).toBeNull();
  });
  it("adds auto to a one-line allowlist and leaves a missing one alone", () => {
    expect(list(planToml('allowed_models = ["a"]\n', "http://h:1") ?? "")).toEqual(["auto", "a"]);
    expect(list(planToml("x = 1\n", "http://h:1") ?? "")).toBeUndefined();
  });
});
describe("planToml repoints models", () => {
  it("sends every mistral model through mistwatch and leaves others alone", () => {
    const raw =
      '[[models]]\nname = "a"\nprovider = "mistral"\n\n[[models]]\nname = "b"\nprovider = "ollama"\n\n[[providers]]\nname = "mistral"\nprovider = "mistral"\n';
    const out = parse(planToml(raw, "http://h:1") ?? "");
    const models = out.models as Record<string, unknown>[];
    expect(models.find((m) => m.name === "a")?.provider).toBe("mistwatch");
    expect(models.find((m) => m.name === "b")?.provider).toBe("ollama");
    expect((out.providers as Record<string, unknown>[]).find((p) => p.name === "mistral")?.provider).toBe("mistral");
  });
});
describe("planToml display names", () => {
  const raw = [
    "[[models]]",
    'name = "mistral-large-4-0"',
    'provider = "mistral"',
    'display_name = "Mistral Large 4 (Mistwatch)"',
    "",
    "[[models]]",
    'name = "custom-x"',
    'provider = "mistral"',
    'display_name = "Custom X (Mistwatch)"',
    "",
    "[[models]]",
    'name = "b"',
    'provider = "ollama"',
    'display_name = "Beta (Mistwatch)"',
    "",
  ].join("\n");
  it("names models the way Mistwatch does and adds auto", () => {
    const out = planToml(raw, "http://h:1") ?? "";
    const models = parse(out).models as Record<string, unknown>[];
    const label = (n: string) => models.find((m) => m.name === n)?.display_name;
    expect(label("mistral-large-4-0")).toBe("Mistral Large 4");
    expect(label("custom-x")).toBe("Custom X");
    expect(label("b")).toBe("Beta (Mistwatch)");
    expect(label("auto")).toBe("Auto (budget-aware router)");
    expect(planToml(out, "http://h:1")).toBeNull();
  });
});
describe("planToml legacy auto models", () => {
  it("removes auto-fast and auto-max from models and the allowlist", () => {
    const blocks = ["auto-fast", "auto-max"].map(
      (n) => `[[models]]\nname = "${n}"\nprovider = "mistwatch"\nalias = "${n}"\n`,
    );
    const raw = `allowed_models = [\n    "auto-fast",\n    "auto-max",\n    "auto",\n    "a",\n]\n\n${blocks.join("\n")}`;
    const out = planToml(raw, "http://h:1") ?? "";
    const doc = parse(out);
    expect(doc.allowed_models).toEqual(["auto", "a"]);
    expect((doc.models as Record<string, unknown>[]).map((m) => m.name)).toEqual(["auto"]);
  });
});

describe("setup where and installed tools", () => {
  const reply401 = async () => new Response('{"error":{"type":"mistwatch_auth"}}', { status: 401 });
  it("asks for a hosted address, skips the local steps and points the tool at it", async () => {
    const seen: string[] = [];
    const h = make({
      interactive: true,
      answers: ["2", "nope", "http://100.64.0.1:8787/"],
      fetch: async (u) => {
        seen.push(String(u));
        return reply401();
      },
    });
    expect(await runSetup(["--harness", "vibe", "--no-banner"], h.deps)).toBe(0);
    expect(seen).toEqual(["http://100.64.0.1:8787/v1/models"]);
    expect(text(h)).toContain("answers (a key is needed");
    expect(text(h)).toContain('Create a key under "API keys"');
    expect(existsSync(paths().cfg)).toBe(false);
    expect(readFileSync(paths().vibe, "utf8")).toContain("http://100.64.0.1:8787/v1");
  });
  it("--url works without questions and does not fail when the server is unreachable", async () => {
    const h = make({
      fetch: async () => {
        throw new Error("boom");
      },
    });
    expect(await runSetup(["--yes", "--url", "http://h:1", "--harness", "vibe", "--no-banner"], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(text(h)).toContain("cannot reach http://h:1");
    expect(existsSync(paths().cfg)).toBe(false);
  });
  it("says which tools are missing and how to install them", async () => {
    const h = make({ installed: ["vibe"] });
    expect(await runSetup(["--yes", "--harness", "vibe,opencode,pi", "--no-banner"], h.deps)).toBe(0);
    expect(text(h)).toContain("npm install -g opencode-ai");
    expect(text(h)).toContain("npm install -g @earendil-works/pi-coding-agent");
    expect(text(h)).not.toContain("uv tool install mistral-vibe");
  });
  it("tells how to install Vibe when it is missing", async () => {
    const h = make({ installed: [] });
    await runSetup(["--yes", "--harness", "vibe", "--no-banner"], h.deps);
    expect(text(h)).toContain("uv tool install mistral-vibe");
  });
});

describe("setup stores the key", () => {
  const ok = async () => new Response("{}", { status: 200 });
  const bad = async () => new Response("{}", { status: 401 });
  const remote = ["--harness", "vibe", "--no-banner", "--url", "http://h:1"];
  it("asks for the key hidden, checks it and stores it with setx on Windows", async () => {
    const saved: [string, string][] = [];
    const h = make({
      interactive: true,
      platform: "win32",
      answers: ["y"],
      fetch: ok,
      secret: async () => "mw-abc123",
      setx: async (n, v) => {
        saved.push([n, v]);
      },
    });
    expect(await runSetup(remote, h.deps)).toBe(0);
    expect(saved).toEqual([["MISTWATCH_TOKEN", "mw-abc123"]]);
    expect(text(h)).toContain("stored as MISTWATCH_TOKEN in your user environment");
    expect(text(h)).not.toContain("mw-abc123");
  });
  it("does not store a key the server rejects or one without the mw- prefix", async () => {
    for (const [fetcher, key, expected] of [
      [bad, "mw-nope", "rejected this key"],
      [ok, "sk-other", "does not look like a Mistwatch key"],
    ] as const) {
      const saved: string[] = [];
      const h = make({
        interactive: true,
        platform: "win32",
        answers: ["y"],
        fetch: fetcher,
        secret: async () => key,
        setx: async (_n, v) => {
          saved.push(v);
        },
      });
      await runSetup(remote, h.deps);
      expect(saved).toEqual([]);
      expect(text(h)).toContain(expected);
    }
  });
  it("adds an export line to the zsh profile after asking, keeping a backup", async () => {
    const profile = join(home, ".zshrc");
    put(profile, "alias x=y\n");
    const h = make({
      interactive: true,
      answers: ["y", "y"],
      fetch: ok,
      secret: async () => "mw-zsh1",
      env: { SHELL: "/bin/zsh" },
    });
    expect(await runSetup(remote, h.deps)).toBe(0);
    const body = readFileSync(profile, "utf8");
    expect(body).toContain('export MISTWATCH_TOKEN="mw-zsh1"');
    expect(body).toContain("alias x=y");
    expect(backups(profile)).toHaveLength(1);
  });
  it("leaves the profile alone when declined and for shells it does not know", async () => {
    const profile = join(home, ".zshrc");
    put(profile, "alias x=y\n");
    const declined = make({
      interactive: true,
      answers: ["y", "n"],
      fetch: ok,
      secret: async () => "mw-no",
      env: { SHELL: "/bin/zsh" },
    });
    await runSetup(remote, declined.deps);
    expect(readFileSync(profile, "utf8")).toBe("alias x=y\n");
    const fish = make({
      interactive: true,
      answers: ["y"],
      fetch: ok,
      secret: async () => "mw-fish",
      env: { SHELL: "/usr/bin/fish" },
    });
    await runSetup(remote, fish.deps);
    expect(text(fish)).toContain("no known shell profile");
    expect(text(fish)).toContain("MISTWATCH_TOKEN");
  });
  it("offers to save the key it just created without asking for one", async () => {
    const saved: string[] = [];
    const h = make({
      interactive: true,
      platform: "win32",
      answers: ["", "n", "1", "y"],
      setx: async (_n, v) => {
        saved.push(v);
      },
    });
    expect(await runSetup(["--no-banner"], h.deps)).toBe(0);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^mw-/);
  });
  it("is silent without a terminal", async () => {
    const h = make({ platform: "win32" });
    await runSetup(["--yes", "--no-banner"], h.deps);
    expect(text(h)).not.toContain("Key ");
  });
});
