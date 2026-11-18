import { describe, expect, it } from "vitest";
import { promptView, rate } from "../src/classifier.ts";
import type { ChatBody } from "../src/types.ts";

const body = (text: string, extra: Record<string, unknown> = {}): ChatBody => ({
  messages: [{ role: "user", content: text }],
  ...extra,
});
const jsonRes = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
describe("promptView", () => {
  it("returns the last user text with context notes", () => {
    const b: ChatBody = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "sec" },
            { type: "text", text: "ond" },
          ],
        },
      ],
    };
    expect(promptView(b)).toBe("sec ond");
    const withTools = body("x".repeat(40), { tools: [{}] });
    expect(promptView(withTools)).toContain("[context: the assistant has tools available]");
    const loop: ChatBody = {
      messages: [
        { role: "user", content: "go" },
        { role: "tool", content: "res" },
      ],
    };
    expect(promptView(loop)).toContain("agentic tool loop");
    const long = {
      messages: Array.from({ length: 12 }, (_, i) => ({ role: i === 11 ? "user" : "assistant", content: `m${i}` })),
    };
    expect(promptView(long)).toContain("long conversation (12 messages)");
  });
  it("truncates by code points without lone surrogates", () => {
    const v = promptView(body("😀".repeat(1900)));
    expect(v).toBe(`${"😀".repeat(1200)}
[...]
${"😀".repeat(600)}`);
    expect(/\p{Cs}/u.test(v)).toBe(false);
    expect(promptView(body("😀".repeat(1800)))).toBe("😀".repeat(1800));
  });
  it("truncates very long prompts keeping head and tail", () => {
    const v = promptView(body(`${"a".repeat(1200)}MID${"z".repeat(700)}`));
    expect(v).toContain("[...]");
    expect(v.startsWith("a".repeat(100))).toBe(true);
    expect(v.endsWith("z".repeat(100))).toBe(true);
    expect(v.length).toBe(1200 + 7 + 600);
  });
});
describe("rate", () => {
  it("parses the difficulty and reports usage tokens", async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async () => {
      calls += 1;
      return jsonRes({
        choices: [{ message: { content: '{"difficulty": 7}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      });
    };
    const b = body("unique prompt alpha for the classifier test");
    expect(await rate(mockFetch, "https://x", "k", b, "m", 1)).toEqual([7, 5, 3]);
    expect(calls).toBe(1);
  });
  it("hits the API once then serves the cache", async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async () => {
      calls += 1;
      return jsonRes({
        choices: [{ message: { content: '{"difficulty": 8}' } }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      });
    };
    const b = body("unique prompt bravo for the classifier test");
    expect(await rate(mockFetch, "https://x", "k", b, "m", 1)).toEqual([8, 9, 4]);
    expect(await rate(mockFetch, "https://x", "k", b, "m", 1)).toEqual([8, 0, 0]);
    expect(calls).toBe(1);
  });
  it("returns null on upstream errors and bad payloads", async () => {
    const boom: typeof fetch = () => Promise.reject(new Error("boom"));
    expect(await rate(boom, "https://x", "k", body("unique charlie prompt"), "m", 1)).toBeNull();
    const badStatus: typeof fetch = async () => new Response("no", { status: 500 });
    expect(await rate(badStatus, "https://x", "k", body("unique delta prompt"), "m", 1)).toBeNull();
    const noScore: typeof fetch = async () => jsonRes({ choices: [{ message: { content: "not json" } }] });
    expect(await rate(noScore, "https://x", "k", body("unique echo prompt"), "m", 1)).toBeNull();
    const empty: typeof fetch = async () => jsonRes({ choices: [] });
    expect(await rate(empty, "https://x", "k", body("unique foxtrot prompt"), "m", 1)).toBeNull();
  });
});
describe("rate hardening", () => {
  it("parses non-ascii decimal digits like Python int()", async () => {
    const reply =
      (s: string): typeof fetch =>
      async () =>
        jsonRes({ choices: [{ message: { content: `{"difficulty": ${s}}` } }] });
    const cp = String.fromCodePoint;
    expect((await rate(reply(cp(0x663)), "https://x", "k", body("digit prompt arabic"), "m", 1))?.[0]).toBe(3);
    expect((await rate(reply(cp(0x1d7d5)), "https://x", "k", body("digit prompt math"), "m", 1))?.[0]).toBe(7);
    expect((await rate(reply(cp(0xff18, 0xff19)), "https://x", "k", body("digit prompt wide"), "m", 1))?.[0]).toBe(10);
    expect((await rate(reply(cp(0xff12, 0xff10)), "https://x", "k", body("digit prompt twenty"), "m", 1))?.[0]).toBe(
      10,
    );
    expect((await rate(reply(cp(0xff14)), "https://x", "k", body("digit prompt four"), "m", 1))?.[0]).toBe(4);
  });
  it("never follows redirects and treats 3xx as failure", async () => {
    let init: RequestInit | undefined;
    const redirecting: typeof fetch = async (_u, i) => {
      init = i;
      return new Response(null, { status: 307, headers: { location: "https://evil.example/" } });
    };
    expect(await rate(redirecting, "https://x", "k", body("unique redirect prompt"), "m", 1)).toBeNull();
    expect(init?.redirect).toBe("manual");
  });
});
