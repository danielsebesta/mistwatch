import { createHash } from "node:crypto";
import { cpLen, messageText, truthy } from "./router.ts";
import type { ChatBody, FetchLike } from "./types.ts";
export const SYSTEM =
  "Rate how hard the user's last request is for an AI assistant on a 0-10 integer scale. " +
  "0-1 greeting or trivial; 2-3 simple question, short edit, translation; " +
  "4-5 moderate coding or analysis; 6-7 multi-step debugging, design, long reasoning; " +
  "8-10 research-grade, hard math or proofs, large system design. " +
  'Reply with JSON only: {"difficulty": <int>}';
const NUM = /"difficulty"\s*:\s*(\d+)/;
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
  if (truthy(body.tools)) notes.push("the assistant has tools available");
  if (msgs.some((m) => m.role === "tool")) notes.push("this is mid-way through an agentic tool loop");
  if (msgs.length > 10) notes.push(`long conversation (${msgs.length} messages)`);
  return last + (notes.length ? `\n\n[context: ${notes.join("; ")}]` : "");
};
export const rate = async (
  fetchFn: FetchLike,
  base: string,
  key: string,
  body: ChatBody,
  model: string,
  timeoutS: number,
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
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data: unknown = await res.json();
    const choices = isRec(data) && Array.isArray(data.choices) ? data.choices : [];
    const c0 = choices[0];
    const content = isRec(c0) && isRec(c0.message) && typeof c0.message.content === "string" ? c0.message.content : "";
    const m = NUM.exec(content);
    if (!m || m[1] === undefined) return null;
    score = Math.max(0, Math.min(10, Number.parseInt(m[1], 10)));
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
