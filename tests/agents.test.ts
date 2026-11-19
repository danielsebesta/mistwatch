import { describe, expect, it } from "vitest";
import { dumpJson, llmsTxt, merge, models, opencode, pi, render, TOOL_ORDER, vibe } from "../src/agents.ts";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BASE = "http://127.0.0.1:8787";

describe("agents.models", () => {
  it("starts with auto, the only router model, and lists unique ladder models", () => {
    const m = models();
    expect(m[0]?.[0]).toBe("auto");
    expect(m.map(([id]) => id)).not.toContain("auto-fast");
    expect(m.map(([id]) => id)).not.toContain("auto-max");
    expect(m[0]?.[1]).toBe("Auto");
    const ids = m.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("mistral-small-2603");
    expect(ids).toContain("zai-glm-5-3");
    expect(m.length).toBeGreaterThan(3);
  });
});

describe("agents.pi", () => {
  it("emits an openai-completions provider with all models", () => {
    const d = pi(BASE) as Record<string, unknown>;
    const mw = isRec(d.providers) && isRec(d.providers.mistwatch) ? d.providers.mistwatch : {};
    expect(isRec(mw) ? mw.baseUrl : null).toBe(`${BASE}/v1`);
    expect(isRec(mw) ? mw.api : null).toBe("openai-completions");
    expect(isRec(mw) ? mw.apiKey : null).toBe("MISTWATCH_TOKEN");
    const list = isRec(mw) && Array.isArray(mw.models) ? mw.models : [];
    expect(list.length).toBe(models().length);
    const first = isRec(list[0]) ? list[0] : {};
    expect(isRec(first) ? first.id : null).toBe("auto");
    expect(isRec(first) ? first.reasoning : null).toBe(true);
    expect(isRec(first) ? first.contextWindow : null).toBe(262_144);
    expect(isRec(first) ? first.maxTokens : null).toBe(32_768);
    const small = list.find((x) => isRec(x) && x.id === "mistral-small-2603");
    expect(isRec(small) ? small.reasoning : null).toBe(false);
    const custom = pi(BASE, "MY_KEY") as Record<string, unknown>;
    const mw2 = isRec(custom.providers) && isRec(custom.providers.mistwatch) ? custom.providers.mistwatch : {};
    expect(isRec(mw2) ? mw2.apiKey : null).toBe("MY_KEY");
  });
});

describe("agents.opencode", () => {
  it("emits the opencode schema block with model limits", () => {
    const d = opencode(BASE) as Record<string, unknown>;
    expect(d.$schema).toBe("https://opencode.ai/config.json");
    const mw = isRec(d.provider) && isRec(d.provider.mistwatch) ? d.provider.mistwatch : {};
    expect(isRec(mw) ? mw.npm : null).toBe("@ai-sdk/openai-compatible");
    expect(isRec(mw) ? mw.name : null).toBe("mistwatch");
    const o = isRec(mw) && isRec(mw.options) ? mw.options : {};
    expect(isRec(o) ? o.baseURL : null).toBe(`${BASE}/v1`);
    expect(isRec(o) ? o.apiKey : null).toBe("{env:MISTWATCH_TOKEN}");
    const ms = isRec(mw) && isRec(mw.models) ? mw.models : {};
    const auto = isRec(ms) && isRec(ms.auto) ? ms.auto : {};
    expect(isRec(auto) && isRec(auto.limit) ? auto.limit.context : null).toBe(262_144);
    expect(isRec(auto) && isRec(auto.limit) ? auto.limit.output : null).toBe(32_768);
  });
});

describe("agents.vibe", () => {
  it("emits the TOML provider block", () => {
    const t = vibe(BASE);
    expect(t).toContain('name = "mistwatch"');
    expect(t).toContain(`api_base = "${BASE}/v1"`);
    expect(t).toContain('api_key_env_var = "MISTWATCH_TOKEN"');
    expect(t).toContain('backend = "mistral"');
    expect(t).toContain('provider = "mistwatch"');
  });
});

describe("agents.merge", () => {
  it("merges nested objects and overwrites scalars", () => {
    const dst = { a: 1, p: { x: 1, y: 2 }, keep: "yes" };
    const out = merge(dst, { p: { y: 9, z: 3 }, b: 2 });
    expect(out).toEqual({ a: 1, p: { x: 1, y: 9, z: 3 }, keep: "yes", b: 2 });
  });
  it("replaces non-object values instead of merging", () => {
    const dst = { p: { x: 1 }, arr: [1] };
    merge(dst, { p: 5, arr: [2, 3] });
    expect(dst).toEqual({ p: 5, arr: [2, 3] });
  });
  it("ignores prototype keys", () => {
    merge({}, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("agents.render", () => {
  it("produces all four tool configs in order", () => {
    const out = TOOL_ORDER.map((t) => render(t, BASE));
    expect(out.map((t) => t.tool)).toEqual(["opencode", "pi", "vibe", "env"]);
    for (const c of out) {
      expect(c.content).toContain("/v1");
      expect(c.note).toContain("MISTWATCH_TOKEN");
      expect(c.filename.length).toBeGreaterThan(0);
      expect(c.language.length).toBeGreaterThan(0);
    }
    const env = out.find((t) => t.tool === "env");
    expect(env?.filename).toBe("mistwatch.env");
    expect(env?.path).toBe("environment");
    expect(env?.content).toContain(`export OPENAI_BASE_URL="${BASE}/v1"`);
    const oc = out.find((t) => t.tool === "opencode");
    expect(oc?.filename).toBe("opencode.json");
    expect(oc?.path).toBe("~/.config/opencode/opencode.json");
    const pv = out.find((t) => t.tool === "pi");
    expect(pv?.filename).toBe("models.json");
  });
});

describe("agents.dumpJson", () => {
  it("writes JSON with indent 2 and ASCII escaping", () => {
    expect(dumpJson({ a: 1, b: [true, null] })).toBe(JSON.stringify({ a: 1, b: [true, null] }, null, 2));
    expect(dumpJson({ č: "ď" })).toBe('{\n  "\\u010d": "\\u010f"\n}');
  });
});

describe("agents.llmsTxt", () => {
  it("documents the endpoint, auth, errors and agent setup", () => {
    const t = llmsTxt(BASE);
    expect(t).toContain(`${BASE}/v1`);
    expect(t).toContain("/v1/chat/completions");
    expect(t).toContain("mistwatch_budget_exhausted");
    expect(t).toContain("mistwatch_auth");
    expect(t).toContain("Mistral-Vibe");
    expect(t).toContain("MISTWATCH_TOKEN");
    expect(t).toContain("npx mistwatch setup --yes --harness vibe");
    expect(t).toContain("AGENTS.md");
    expect(t).toContain('Bearer $MISTWATCH_TOKEN" http://127.0.0.1:8787/v1/models');
    expect(t).toContain("not affiliated with Mistral AI");
  });
});
