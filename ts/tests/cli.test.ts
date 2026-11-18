import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MISTWATCH_NO_KEYRING = "1";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
let home: string;
let logs: string[];
let errs: string[];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "MISTWATCH_HOME",
  "MISTWATCH_CONFIG",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "VIBE_HOME",
] as const;
const setEnv = (k: string, v: string | undefined): void => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mw-cli-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setEnv("MISTWATCH_HOME", join(home, "mw"));
  setEnv("MISTWATCH_CONFIG", undefined);
  setEnv("HOME", home);
  setEnv("USERPROFILE", home);
  setEnv("XDG_CONFIG_HOME", undefined);
  setEnv("APPDATA", undefined);
  setEnv("VIBE_HOME", undefined);
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => errs.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) setEnv(k, saved[k]);
  rmSync(home, { recursive: true, force: true });
});
const main = async (argv: string[]): Promise<number> => (await import("../src/cli.ts")).main(argv);

describe("cli argument parsing", () => {
  it("prints usage with exit 2 for no command and unknown commands", async () => {
    expect(await main([])).toBe(2);
    expect(errs.join("\n")).toContain("usage: mistwatch");
    expect(await main(["bogus"])).toBe(2);
    expect(errs.join("\n")).toContain("unknown command 'bogus'");
  });
  it("prints usage with exit 0 on --help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(logs.join("\n")).toContain("usage: mistwatch");
  });
  it("lists setup and routes it", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(logs.join("\n")).toContain("setup ");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["setup", "--bogus"])).toBe(2);
    expect(write.mock.calls.join("")).toContain("mistwatch:");
  });
  it("rejects bad flags and missing arguments with exit 2", async () => {
    expect(await main(["agent-config"])).toBe(2);
    expect(errs.join("\n")).toContain("requires tool 'pi' or 'opencode'");
    expect(await main(["agent-config", "emacs"])).toBe(2);
    expect(await main(["status", "--bogus"])).toBe(2);
    expect(errs.join("\n")).toContain("mistwatch:");
    expect(await main(["passwd"])).toBe(2);
    expect(await main(["route", "--pressure", "abc", "x"])).toBe(2);
    expect(errs.join("\n")).toContain("--pressure must be a number");
  });
});

describe("cli init and quick commands", () => {
  it("writes the config once and only overwrites with --force", async () => {
    expect(await main(["init"])).toBe(0);
    const cfg = join(home, "mw", "config.toml");
    expect(existsSync(cfg)).toBe(true);
    expect(readFileSync(cfg, "utf8")).toContain("port = 8787");
    expect(await main(["init"])).toBe(1);
    expect(logs.join("\n")).toContain("already exists (use --force)");
    expect(await main(["init", "--force"])).toBe(0);
  });
  it("prints the vibe provider block", async () => {
    await main(["init"]);
    expect(await main(["vibe-config"])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain('name = "mistwatch"');
    expect(out).toContain('api_base = "http://127.0.0.1:8787/v1"');
    expect(out).toContain('backend = "mistral"');
  });
  it("dry-runs the router without touching the config", async () => {
    expect(await main(["route", "hello world"])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("mistral-small-2603");
    expect(out).toContain("level=0/6");
  });
  it("reports missing config like python", async () => {
    await expect(main(["status"])).rejects.toThrow("not found - run `mistwatch init` first");
  });
});

describe("cli agent-config", () => {
  it("prints the pi provider without --write", async () => {
    await main(["init"]);
    logs.length = 0;
    errs.length = 0;
    expect(await main(["agent-config", "pi"])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("models.json");
    const payload: unknown = JSON.parse(out.slice(out.indexOf("\n") + 1));
    const mw =
      isRec(payload) && isRec(payload.providers) && isRec(payload.providers.mistwatch)
        ? payload.providers.mistwatch
        : {};
    expect(isRec(mw) ? mw.api : null).toBe("openai-completions");
    const first = isRec(mw) && Array.isArray(mw.models) ? mw.models[0] : null;
    expect(isRec(first) ? first.id : null).toBe("auto");
    expect(errs.join("\n")).toContain("--write");
    expect(existsSync(join(home, ".pi", "agent", "models.json"))).toBe(false);
  });
  it("writes, merges and backs up the opencode config", async () => {
    await main(["init"]);
    const f = join(home, ".config", "opencode", "opencode.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(f, JSON.stringify({ theme: "x", provider: { other: { a: 1 } } }));
    expect(await main(["agent-config", "opencode", "--write"])).toBe(0);
    const d: unknown = JSON.parse(readFileSync(f, "utf8"));
    expect(isRec(d) ? d.theme : null).toBe("x");
    const prov = isRec(d) && isRec(d.provider) ? d.provider : {};
    expect(isRec(prov) && isRec(prov.other) ? prov.other : null).toEqual({ a: 1 });
    const mw = isRec(prov) && isRec(prov.mistwatch) ? prov.mistwatch : {};
    const o = isRec(mw) && isRec(mw.options) ? mw.options : {};
    expect(isRec(o) ? o.apiKey : null).toBe("{env:MISTWATCH_TOKEN}");
    const ms = isRec(mw) && isRec(mw.models) ? mw.models : {};
    expect(isRec(ms) ? "auto" in ms : false).toBe(true);
    const bak = readFileSync(`${f}.bak`, "utf8");
    expect(JSON.parse(bak)).toEqual({ theme: "x", provider: { other: { a: 1 } } });
  });
  it("creates parent directories on first write", async () => {
    await main(["init"]);
    expect(await main(["agent-config", "opencode", "--write"])).toBe(0);
    const f = join(home, ".config", "opencode", "opencode.json");
    expect(existsSync(f)).toBe(true);
    const d: unknown = JSON.parse(readFileSync(f, "utf8"));
    expect(isRec(d) && isRec(d.provider) && "mistwatch" in d.provider).toBe(true);
    expect(existsSync(`${f}.bak`)).toBe(false);
  });
  it("refuses to overwrite non-plain JSON and leaves it untouched", async () => {
    await main(["init"]);
    const f = join(home, ".config", "opencode", "opencode.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(f, "{ // comments\n}");
    expect(await main(["agent-config", "opencode", "--write"])).toBe(1);
    expect(logs.join("\n")).toContain("is not plain JSON");
    expect(readFileSync(f, "utf8")).toBe("{ // comments\n}");
    expect(existsSync(`${f}.bak`)).toBe(false);
    writeFileSync(f, "[1,2]");
    expect(await main(["agent-config", "opencode", "--write"])).toBe(1);
    expect(readFileSync(f, "utf8")).toBe("[1,2]");
  });
  it("honors --env for the api key variable", async () => {
    await main(["init"]);
    logs.length = 0;
    expect(await main(["agent-config", "pi", "--env", "MY_TOKEN"])).toBe(0);
    expect(logs.join("\n")).toContain('"apiKey": "MY_TOKEN"');
  });
});
