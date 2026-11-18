import { createHash } from "node:crypto";
import { cpLen, messageText, truthy } from "./router.ts";
import type { ChatBody, FetchLike } from "./types.ts";
export const SYSTEM =
  "Rate how hard the user's last request is for an AI coding assistant on a 0-20 integer scale. " +
  "Judge the whole situation, not only the wording: the request, the project instructions if shown, " +
  "the tools available, what the assistant has already done and how much code it has read. " +
  "A short request can be hard in a large or unusual project, and a long one can be easy. " +
  "0-2 greeting or trivial; 3-5 simple question, short edit, translation; " +
  "6-9 small coding task or analysis; 10-13 moderate coding, multi-file change; " +
  "14-17 multi-step debugging, design, long reasoning; " +
  "18-20 research-grade, hard math or proofs, large system design. " +
  'Reply with JSON only: {"difficulty": <int>}';
const ND = /\p{Nd}/u;
const NUM = /"difficulty"\s*:\s*(\p{Nd}+)/u;
const digitValue = (c: number): number => {
  if (c >= 0x1d7ce && c <= 0x1d7ff) return (c - 0x1d7ce) % 10;
  // Nd code points come in contiguous 0-9 blocks, so adjacent blocks form a run whose length is a multiple of ten
  let v = 0;
  while (ND.test(String.fromCodePoint(c - v - 1))) v++;
  return v % 10;
};
export const parseDigits = (s: string): number => {
  let n = 0;
  for (const ch of s) n = Math.min(n * 10 + digitValue(ch.codePointAt(0) ?? 0), 1e6);
  return n;
};
export const CACHE_MAX = 1024;
const cache = new Map<string, number>();
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const toInt = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  throw new TypeError("int() failed");
};
export const promptView = (body: ChatBody): string => {
  const msgs = (Array.isArray(body.messages) ? body.messages : []).filter(isRec);
  let last = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user") {
      last = messageText(m.content);
      break;
    }
  }
  if (cpLen(last) > 1800) {
    const cps = Array.from(last);
    last = `${cps.slice(0, 1200).join("")}\n[...]\n${cps.slice(-600).join("")}`;
  }
  const notes: string[] = [];
  if (truthy(body.tools)) {
    const names = toolNames(body);
    notes.push(`the assistant has tools available${names.length ? ` (${names.join(", ")})` : ""}`);
  }
  if (msgs.some((m) => m.role === "tool")) {
    const used = recentToolCalls(msgs);
    const read = msgs.reduce((n, m) => n + (m.role === "tool" ? cpLen(messageText(m.content)) : 0), 0);
    notes.push(
      `this is mid-way through an agentic tool loop${used.length ? `, recent tool calls: ${used.join(", ")}` : ""}, about ${read} characters of tool output so far`,
    );
  }
  if (msgs.length > 10) notes.push(`long conversation (${msgs.length} messages)`);
  const project = projectContext(msgs);
  return (
    last +
    (notes.length ? `\n\n[context: ${notes.join("; ")}]` : "") +
    (project ? `\n\n[project instructions]\n${project}` : "")
  );
};
const isNamed = (v: unknown): v is { function: { name: string } } =>
  isRec(v) && isRec(v.function) && typeof v.function.name === "string";
const toolNames = (body: ChatBody): string[] =>
  (Array.isArray(body.tools) ? body.tools : [])
    .filter(isNamed)
    .map((t) => t.function.name)
    .slice(0, 25);
const recentToolCalls = (msgs: Record<string, unknown>[]): string[] =>
  msgs
    .slice(-12)
    .flatMap((m) => (m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls.filter(isNamed) : []))
    .map((t) => t.function.name)
    .slice(-6);
const PROJECT_MARK = /AGENTS\.md|CLAUDE\.md|GEMINI\.md|project instructions|<project/i;
// The system prompt of a coding agent carries the project's own instructions (AGENTS.md and the like).
// Show the tiny model that part, or the opening of the prompt when no such marker is present.
const PROJECT_CP = 1200;
const projectContext = (msgs: Record<string, unknown>[]): string => {
  const sys = msgs
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => messageText(m.content))
    .join("\n");
  if (sys.trim() === "") return "";
  const at = PROJECT_MARK.exec(sys)?.index ?? 0;
  return Array.from(sys.slice(Math.max(0, at - 100), at + 6000))
    .slice(0, PROJECT_CP)
    .join("")
    .trim();
};
export const rate = async (
  fetchFn: FetchLike,
  base: string,
  key: string,
  body: ChatBody,
  model: string,
  timeoutS: number,
  signal?: AbortSignal,
): Promise<[number, number, number] | null> => {
  const view = promptView(body);
  const ck = createHash("sha1").update(view, "utf8").digest("hex");
  const hit = cache.get(ck);
  if (hit !== undefined) {
    cache.delete(ck);
    cache.set(ck, hit);
    return [hit, 0, 0];
  }
  const req = {
    model,
    temperature: 0,
    max_tokens: 24,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: view },
    ],
  };
  let score: number;
  let promptT = 0;
  let completionT = 0;
  try {
    const res = await fetchFn(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": "mistwatch/0.1 router",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutS * 1000), ...(signal ? [signal] : [])]),
      redirect: "manual",
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data: unknown = await res.json();
    const choices = isRec(data) && Array.isArray(data.choices) ? data.choices : [];
    const c0 = choices[0];
    const content = isRec(c0) && isRec(c0.message) && typeof c0.message.content === "string" ? c0.message.content : "";
    const m = NUM.exec(content);
    if (!m || m[1] === undefined) return null;
    score = Math.max(0, Math.min(20, parseDigits(m[1])));
    const u = isRec(data) && isRec(data.usage) ? data.usage : {};
    promptT = toInt(u.prompt_tokens);
    completionT = toInt(u.completion_tokens);
  } catch {
    return null;
  }
  cache.set(ck, score);
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return [score, promptT, completionT];
};
