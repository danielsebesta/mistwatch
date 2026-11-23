import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(out).toContain("zai-glm-5-3-flash");
    expect(out).toContain("effort=low");
  });
  it("reports a missing config", async () => {
    await expect(main(["status"])).rejects.toThrow("not found - run `mistwatch init` first");
  });
});

describe("cli status", () => {
  it("loads the persisted shared-budget links like the web API", async () => {
    await main(["init"]);
    const { openApp } = await import("../src/open.ts");
    const app = openApp();
    const now = Date.now() / 1000;
    for (const name of ["a", "b"]) {
      app.store.createAccount(name);
      app.db.addSnapshot({
        ts: now,
        account: name,
        pool: "api",
        used_eur: 5,
        initial_eur: 10,
        reset_at: now + 86400,
        currency: "EUR",
      });
    }
    app.db.setMeta("links", JSON.stringify({ b: { canonical: "a", confidence: "sure" } }));
    app.db.close();
    logs.length = 0;
    expect(await main(["status", "--json"])).toBe(0);
    const out: unknown = JSON.parse(logs.join("\n"));
    const pools = isRec(out) && Array.isArray(out.pools) ? out.pools : [];
    expect(pools.map((p) => (isRec(p) ? [p.account, p.group, p.members] : null))).toEqual([
      ["a", "a", ["a", "b"]],
      ["b", "a", ["a", "b"]],
    ]);
  });
});
