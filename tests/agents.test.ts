import { describe, expect, it } from "vitest";
import { dumpJson, llmsTxt, models, render, TOOL_ORDER, vibe } from "../src/agents.ts";

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

describe("agents.render", () => {
  it("produces the tool config", () => {
    const out = TOOL_ORDER.map((t) => render(t, BASE));
    expect(out.map((t) => t.tool)).toEqual(["vibe"]);
    for (const c of out) {
      expect(c.content).toContain("/v1");
      expect(c.note).toContain("MISTWATCH_TOKEN");
      expect(c.filename.length).toBeGreaterThan(0);
      expect(c.language.length).toBeGreaterThan(0);
    }
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
