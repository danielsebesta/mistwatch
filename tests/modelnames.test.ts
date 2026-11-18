import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { autoname, createModelNames } from "../src/modelnames.ts";
import { usage } from "../src/usage.ts";
import { must } from "./helpers.ts";

describe("autoname", () => {
  it.each([
    ["zai-glm-5-3-flash", "GLM 5.3 Flash"],
    ["zai-glm-5-3", "GLM 5.3"],
    ["mistral-large-4-0", "Mistral Large 4"],
    ["ministral-3b-2512", "Ministral 3B (2512)"],
    ["deepseek-v4-1-flash-1017", "DeepSeek V4.1 Flash (1017)"],
    ["labs-leanstral-1-5-1", "Labs Leanstral 1.5.1"],
    ["voxtral-mini-tts-2603", "Voxtral Mini TTS (2603)"],
    ["mistral-embed-2312", "Mistral Embed (2312)"],
    ["foo-latest", "Foo (latest)"],
    ["mistral-medium-3.5", "Mistral Medium 3.5"],
  ])("%s -> %s", (raw, pretty) => {
    expect(autoname(raw)).toBe(pretty);
  });
});
describe("resolution", () => {
  it("built-in table beats the prettifier and covers aliases", () => {
    const n = createModelNames(openDb(":memory:"));
    expect(n.resolve("deepseek-v4-1-flash-1017")).toEqual(["DeepSeek V4.1 Flash", "built-in"]);
    for (const alias of ["mistral-large-4-0", "mistral-large-4", "mistral-large-latest"])
      expect(n.display(alias)).toBe("Mistral Large 4");
    expect(n.display("mistral-vibe-cli-latest")).toBe("Mistral Medium 3.5");
    expect(n.resolve("something-new-7b")).toEqual(["Something New 7B", "auto"]);
    expect(n.display(null)).toBe("(unknown)");
  });
  it("overrides win and can be reset", () => {
    const n = createModelNames(openDb(":memory:"));
    n.setOverride("zai-glm-5-3", "Big GLM");
    expect(n.resolve("zai-glm-5-3")).toEqual(["Big GLM", "custom"]);
    n.clearOverride("zai-glm-5-3");
    expect(n.display("zai-glm-5-3")).toBe("GLM 5.3");
    expect(() => n.setOverride("x", "   ")).toThrow("Name must be 1-80 printable characters.");
  });
  it("catalog groups aliases and uses Mistral names", () => {
    const db = openDb(":memory:");
    const n = createModelNames(db);
    const ins = db.stmt("INSERT INTO model_catalog(model_id, name, aliases, description) VALUES(?,?,?,?)");
    ins.run("mistral-ocr-latest", "Mistral OCR 4.1", '["mistral-ocr-4"]', null);
    ins.run("mistral-ocr-4", "Mistral OCR 4.1", '["mistral-ocr-latest"]', null);
    ins.run("brand-new-1", "brand-new-1", "[]", "desc");
    n.reload();
    expect(n.resolve("mistral-ocr-4")).toEqual(["Mistral OCR 4.1", "mistral"]);
    expect(n.groupKey("mistral-ocr-latest")).toBe(n.groupKey("mistral-ocr-4"));
    n.setOverride("mistral-ocr-4", "OCR");
    expect(n.display("mistral-ocr-latest")).toBe("OCR");
  });
});
describe("charts and listing", () => {
  it("chart merges aliases into one series", () => {
    const db = openDb(":memory:");
    const now = Date.now() / 1000;
    ["mistral-large-4-0", "mistral-large-latest", "mistral-large-4"].forEach((m, i) => {
      db.addLedger({
        ts: now - 60 * i,
        account: "a",
        pool: "vibe",
        client: "c",
        model: m,
        endpoint: "e",
        cost_eur: 1.0,
        source: "proxy",
      });
    });
    const u = usage(db, "7d", "model", now);
    expect(u.series.map((s) => [s.name, Math.round(s.total * 100) / 100])).toEqual([["Mistral Large 4", 3.0]]);
  });
  it("refresh stores the catalog and listing groups aliases", async () => {
    const db = openDb(":memory:");
    const n = createModelNames(db);
    const payload = {
      data: [
        { id: "mistral-large-4-0", name: "mistral-large-4", aliases: ["mistral-large-latest"], description: "Large" },
        { id: "mistral-large-latest", name: "mistral-large-4", aliases: ["mistral-large-4-0"] },
      ],
    };
    let calls = 0;
    const mockFetch: typeof fetch = async (input) => {
      calls += 1;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/v1/models")
        ? new Response(JSON.stringify(payload), { status: 200 })
        : new Response("{}", { status: 404 });
    };
    db.addLedger({
      ts: Date.now() / 1000,
      account: "a",
      pool: "vibe",
      client: "c",
      model: "mistral-large-latest",
      endpoint: "e",
      cost_eur: 0.1,
      source: "proxy",
    });
    expect(await n.refresh(mockFetch, "https://x", "key-123")).toBe(2);
    const rows = new Map(n.listing(true).map((r) => [r.key, r]));
    const grp = must(rows.get("mistral-large-4"));
    expect(grp.display).toBe("Mistral Large 4");
    expect(grp.calls).toBe(1);
    expect(grp.ids).toEqual(["mistral-large-4-0", "mistral-large-latest"]);
    n.setOverride("mistral-large-4", "Large");
    expect(n.display("mistral-large-latest")).toBe("Large");
    n.clearOverride("mistral-large-4");
    expect(n.display("mistral-large-latest")).toBe("Mistral Large 4");
    expect(
      await n.maybeRefresh(mockFetch, "https://x", [
        { name: "a", keys: { vibe: "key-123" }, priority: 1, enabled: true, manual: {} },
      ]),
    ).toBeNull();
    expect(calls).toBe(1);
  });
});
describe("string semantics", () => {
  it("strips the Unicode whitespace set but keeps BOM", () => {
    const n = createModelNames(openDb(":memory:"));
    expect(n.resolve("\x1cmistral-large-latest\x85")[0]).toBe("Mistral Large 4");
    n.setOverride("m", "\x1fName\x1c");
    expect(n.display("m")).toBe("Name");
    n.setOverride("m2", "﻿Name");
    expect(n.display("m2")).toBe("﻿Name");
  });
  it("counts code points for the 80 char limit", () => {
    const n = createModelNames(openDb(":memory:"));
    expect(() => n.setOverride("m", "😀".repeat(80))).not.toThrow();
    expect(() => n.setOverride("m", "😀".repeat(81))).toThrow("1-80");
  });
  it("sorts in code point order", () => {
    const n = createModelNames(openDb(":memory:"));
    n.setOverride("￿x", "x1");
    n.setOverride("\u{10000}x", "x1");
    const keys = n.listing().map((r) => r.key);
    expect(keys.filter((k) => k.endsWith("x"))).toEqual(["￿x", "\u{10000}x"]);
  });
  it("does not follow redirects when refreshing", async () => {
    const n = createModelNames(openDb(":memory:"));
    let redirect: RequestInit["redirect"];
    const f: typeof fetch = async (_i, init) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    };
    await expect(n.refresh(f, "https://x", "k")).rejects.toThrow("302");
    expect(redirect).toBe("manual");
  });
});
describe("prototype-named models", () => {
  it.each(["constructor", "__proto__", "toString"])("%s resolves as an unknown name", (id) => {
    const n = createModelNames(openDb(":memory:"));
    expect(n.resolve(id)[1]).toBe("auto");
    expect(() => n.listing(true)).not.toThrow();
  });
  it("stores and lists overrides under prototype-like ids", () => {
    const n = createModelNames(openDb(":memory:"));
    n.setOverride("__proto__", "Proto");
    n.setOverride("constructor", "Ctor");
    expect(n.resolve("__proto__")).toEqual(["Proto", "custom"]);
    expect(n.resolve("constructor")).toEqual(["Ctor", "custom"]);
    expect(n.listing().map((r) => r.key)).toEqual(expect.arrayContaining(["__proto__", "constructor"]));
    expect(n.resolve("toString")[1]).toBe("auto");
  });
});
