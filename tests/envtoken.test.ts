import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkKey, manualCommand, persistToken, profileFor } from "../src/envtoken.ts";

const res = (status: number) => async () => new Response("{}", { status });
describe("checkKey", () => {
  it("tells a good key, a rejected key and an unreachable server apart", async () => {
    expect(await checkKey("http://h", "mw-a", res(200))).toBe("valid");
    expect(await checkKey("http://h", "mw-a", res(401))).toBe("rejected");
    expect(await checkKey("http://h", "mw-a", res(502))).toBe("unreachable");
    expect(
      await checkKey("http://h", "mw-a", async () => {
        throw new Error("down");
      }),
    ).toBe("unreachable");
  });
  it("sends the key as a bearer token to /v1/models", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    await checkKey("http://h:1", "mw-abc", async (u, init) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("Authorization") };
      return new Response("{}");
    });
    expect(seen).toEqual({ url: "http://h:1/v1/models", auth: "Bearer mw-abc" });
  });
});
describe("persistToken", () => {
  const base = (home: string, shell: string | undefined, yes = true) => ({
    platform: "linux" as const,
    home,
    shell,
    now: () => new Date("2026-11-18T12:00:00Z"),
    confirm: async () => yes,
    backup: (path: string) => writeFileSync(`${path}.bak`, readFileSync(path)),
  });
  it("replaces an earlier export line instead of adding a second one", async () => {
    const home = mkdtempSync(join(tmpdir(), "mw-env-"));
    const rc = join(home, ".zshrc");
    writeFileSync(rc, 'a=1\nexport MISTWATCH_TOKEN="mw-old"\nb=2\n');
    const r = await persistToken("mw-new", base(home, "/usr/bin/zsh"));
    expect(r.saved).toBe(true);
    const body = readFileSync(rc, "utf8");
    expect(body.match(/MISTWATCH_TOKEN/g)).toHaveLength(1);
    expect(body).toContain('export MISTWATCH_TOKEN="mw-new"');
    expect(body).toContain("a=1");
    expect(body).toContain("b=2");
    expect(readdirSync(home)).toContain(".zshrc.bak");
  });
  it("creates the profile when there is none, adds a newline when missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "mw-env-"));
    expect((await persistToken("mw-x", base(home, "/bin/zsh"))).saved).toBe(true);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe('# Mistwatch\nexport MISTWATCH_TOKEN="mw-x"\n');
    writeFileSync(join(home, ".bashrc"), "no newline");
    await persistToken("mw-y", base(home, "/bin/bash"));
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(
      'no newline\n# Mistwatch\nexport MISTWATCH_TOKEN="mw-y"\n',
    );
  });
  it("writes nothing when declined or when the shell is unknown", async () => {
    const home = mkdtempSync(join(tmpdir(), "mw-env-"));
    const no = await persistToken("mw-x", base(home, "/bin/zsh", false));
    expect(no.saved).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    const fish = await persistToken("mw-x", base(home, "/usr/bin/fish"));
    expect(fish.saved).toBe(false);
    if (!fish.saved) expect(fish.manual).toContain("set -Ux MISTWATCH_TOKEN");
  });
  it("uses setx on Windows and reports a failure", async () => {
    const calls: string[][] = [];
    const win = {
      ...base("C:/h", undefined),
      platform: "win32" as const,
      setx: async (n: string, v: string) => {
        calls.push([n, v]);
      },
    };
    expect((await persistToken("mw-w", win)).saved).toBe(true);
    expect(calls).toEqual([["MISTWATCH_TOKEN", "mw-w"]]);
    const failing = await persistToken("mw-w", {
      ...win,
      setx: async () => {
        throw new Error("denied");
      },
    });
    expect(failing.saved).toBe(false);
    if (!failing.saved) expect(failing.reason).toContain("denied");
  });
  it("knows the profile and the manual command per shell", () => {
    expect(profileFor("/bin/zsh", "/h")).toBe(join("/h", ".zshrc"));
    expect(profileFor("/usr/bin/fish", "/h")).toBeNull();
    expect(manualCommand("win32", undefined)).toContain("setx MISTWATCH_TOKEN");
  });
});
