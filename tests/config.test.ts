import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anyKey,
  clientBaseUrl,
  configPath,
  defaultConfig,
  homeDir,
  keyFor,
  loadConfig,
  resolveSecret,
} from "../src/config.ts";
import type { Account } from "../src/types.ts";

const acct = (over: Partial<Account> = {}): Account => ({
  name: "a",
  keys: {},
  priority: 100,
  enabled: true,
  manual: {},
  ...over,
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("paths and secrets", () => {
  it("honours MISTWATCH_HOME and MISTWATCH_CONFIG", () => {
    vi.stubEnv("MISTWATCH_HOME", "/tmp/mw-home-x");
    vi.stubEnv("MISTWATCH_CONFIG", "/tmp/mw-cfg-x.toml");
    expect(homeDir()).toBe("/tmp/mw-home-x");
    expect(configPath()).toBe("/tmp/mw-cfg-x.toml");
    vi.stubEnv("MISTWATCH_CONFIG", "");
    expect(configPath()).toBe(join("/tmp/mw-home-x", "config.toml"));
  });
  it("resolves env, literal and errors", () => {
    vi.stubEnv("MW_T1", "abc123");
    expect(resolveSecret("env:MW_T1")).toBe("abc123");
    expect(resolveSecret("literal-key")).toBe("literal-key");
    expect(() => resolveSecret("env:MW_T_NOPE")).toThrow("environment variable MW_T_NOPE is not set");
  });
  it("keyFor and anyKey resolve pool keys", () => {
    vi.stubEnv("MW_VIBE", "vk");
    const a = acct({ keys: { vibe: "env:MW_VIBE", api: "lit" } });
    expect(keyFor(a, "vibe")).toBe("vk");
    expect(keyFor(a, "api")).toBe("lit");
    expect(keyFor(a, "missing")).toBeNull();
    expect(anyKey(a)).toBe("vk");
    expect(() => anyKey(acct())).toThrow("account a has no keys configured");
  });
});
describe("loadConfig floats", () => {
  const load = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "mwcfg-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, body);
    return () => loadConfig(p);
  };
  it("rejects strings that are not valid floats", () => {
    for (const s of ['""', '"0x10"', '"0b1"', '"abc"']) {
      expect(load(`[pricing]\nusd_to_eur = ${s}\n`)).toThrow();
    }
  });
  it("accepts numeric strings", () => {
    expect(load('[pricing]\nusd_to_eur = " 0.5e0 "\n')().usd_to_eur).toBe(0.5);
  });
});
describe("clientBaseUrl", () => {
  it("maps wildcard hosts to loopback and brackets IPv6", () => {
    expect(clientBaseUrl({ host: "127.0.0.1", port: 8787 })).toBe("http://127.0.0.1:8787");
    expect(clientBaseUrl({ host: "0.0.0.0", port: 1 }, "/")).toBe("http://127.0.0.1:1/");
    expect(clientBaseUrl({ host: "::", port: 1 })).toBe("http://127.0.0.1:1");
    expect(clientBaseUrl({ host: "::1", port: 2 })).toBe("http://[::1]:2");
    expect(clientBaseUrl({ host: "mw.lan", port: 3 })).toBe("http://mw.lan:3");
  });
});
describe("allowed_hosts", () => {
  it("is normalised and validated", () => {
    const ok = (body: string) => {
      const dir = mkdtempSync(join(tmpdir(), "mwcfg-"));
      const p = join(dir, "config.toml");
      writeFileSync(p, body);
      return loadConfig(p);
    };
    expect(ok("").allowed_hosts).toEqual([]);
    expect(
      ok(`[server]
allowed_hosts = [" MW.Example.com. ", ""]
`).allowed_hosts,
    ).toEqual(["mw.example.com"]);
    expect(
      ok(`[server]
allowed_hosts = ["a.trycloudflare.com"]
`).allowed_hosts,
    ).toEqual(["a.trycloudflare.com"]);
    expect(
      ok(`[server]
allowed_hosts = ["fd00::5", "[fd00::6]"]
`).allowed_hosts,
    ).toEqual(["fd00::5", "fd00::6"]);
    for (const bad of ["mw.example.com:8443", "https://mw.example.com", "a/b"])
      expect(() =>
        ok(`[server]
allowed_hosts = ["${bad}"]
`),
      ).toThrow(/bare host names/);
    expect(() =>
      ok(`[server]
allowed_hosts = "x"
`),
    ).toThrow();
  });
});
describe("loadConfig", () => {
  it("reports invalid TOML without quoting the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "mwcfg-"));
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      `[[accounts]]
name = "a"
keys = { api = "sk-secret-123" 
broken = = 1
`,
    );
    expect(() => loadConfig(p)).toThrow(/invalid TOML at line \d+, column \d+/);
    try {
      loadConfig(p);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("sk-secret-123");
    }
  });
  it("keeps prototype-named TOML keys as plain data", () => {
    const dir = mkdtempSync(join(tmpdir(), "mwcfg-"));
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      `
[pricing.models."__proto__"]
input = 1
output = 2

[pricing.models.constructor]
input = 3
output = 4

[[accounts]]
name = "a"
keys = {}

[[clients]]
name = "c"
token = "t"
`,
    );
    const cfg = loadConfig(p);
    expect(Object.keys(cfg.price_overrides).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(cfg.price_overrides)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).input).toBeUndefined();
  });
  it("applies TOML overrides and keeps defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "mwcfg-"));
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      `
[server]
host = "0.0.0.0"
port = 9999

[upstream]
base_url = "https://example.com/"

[pricing]
usd_to_eur = 0.9

[storage]
db_path = "/tmp/x.db"

[limits]
reserve_pct = 5
burst_day = 2
fallback_to_other_pool = false

[router]
llm_classifier = false
classifier_timeout_s = 1.5

[[accounts]]
name = "main"
priority = 10
enabled = false
[accounts.keys]
vibe = "env:MW_VIBE"
[accounts.manual.vibe]
initial_eur = 100
reset_day = 5

[[clients]]
name = "c1"
token = "tok"
`,
    );
    const cfg = loadConfig(p);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(9999);
    expect(cfg.upstream).toBe("https://example.com");
    expect(cfg.usd_to_eur).toBe(0.9);
    expect(cfg.db_path).toBe("/tmp/x.db");
    expect(cfg.limits.reserve_pct).toBe(5);
    expect(cfg.limits.burst_day).toBe(2);
    expect(cfg.limits.burst_5h).toBe(2.0);
    expect(cfg.limits.fallback_to_other_pool).toBe(false);
    expect(cfg.router.llm_classifier).toBe(false);
    expect(cfg.router.classifier_timeout_s).toBe(1.5);
    expect(cfg.router.classifier_model).toBe("ministral-3b-latest");
    expect(cfg.accounts).toEqual([
      {
        name: "main",
        keys: { vibe: "env:MW_VIBE" },
        priority: 10,
        enabled: false,
        manual: { vibe: { initial_eur: 100, reset_day: 5 } },
      },
    ]);
    expect(cfg.clients).toEqual([{ name: "c1", token: "tok" }]);
  });
  it("returns defaults for an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mwcfg-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, "# nothing\n");
    const cfg = loadConfig(p);
    const def = defaultConfig();
    expect(cfg.host).toBe(def.host);
    expect(cfg.port).toBe(def.port);
    expect(cfg.limits).toEqual(def.limits);
    expect(cfg.accounts).toEqual([]);
  });
  it("fails with a helpful error when the file is missing", () => {
    expect(() => loadConfig("/definitely/missing-x.toml")).toThrow("not found - run `mistwatch init` first");
  });
  it("rejects a non-finite sync_interval_s", () => {
    const p = join(mkdtempSync(join(tmpdir(), "mw-")), "c.toml");
    writeFileSync(p, "[limits]\nsync_interval_s = nan\n");
    expect(() => loadConfig(p)).toThrow("cannot convert");
  });
});
describe("MISTWATCH_HOST", () => {
  it("overrides the host from config.toml", () => {
    const p = join(mkdtempSync(join(tmpdir(), "mw-host-")), "config.toml");
    writeFileSync(p, '[server]\nhost = "127.0.0.1"\n');
    expect(loadConfig(p).host).toBe("127.0.0.1");
    vi.stubEnv("MISTWATCH_HOST", "0.0.0.0");
    expect(loadConfig(p).host).toBe("0.0.0.0");
  });
});
describe("MISTWATCH_ALLOWED_HOSTS", () => {
  it("adds comma separated hosts to the file list", () => {
    const p = join(mkdtempSync(join(tmpdir(), "mw-ah-")), "config.toml");
    writeFileSync(p, '[server]\nallowed_hosts = ["a.example"]\n');
    vi.stubEnv("MISTWATCH_ALLOWED_HOSTS", " B.example, 100.64.0.1 ,a.example");
    expect(loadConfig(p).allowed_hosts).toEqual(["a.example", "b.example", "100.64.0.1"]);
  });
});
