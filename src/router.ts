import type { ChatBody, Decision, Step } from "./types.ts";
export const LADDER: Step[] = [
  { model: "mistral-small-2603", effort: "none", vision: true, ctx: 262_144, label: "small/none" },
  { model: "zai-glm-5-3-flash", effort: "low", vision: true, ctx: 1_048_576, label: "glm-flash/low" },
  { model: "mistral-large-4-0", effort: "medium", vision: true, ctx: 1_048_576, label: "large-4/medium" },
  { model: "mistral-large-4-0", effort: "high", vision: true, ctx: 1_048_576, label: "large-4/high" },
  { model: "deepseek-v4-1-flash-1017", effort: "high", vision: true, ctx: 1_048_576, label: "deepseek/high" },
  { model: "zai-glm-5-3", effort: "high", vision: false, ctx: 1_048_576, label: "glm-5.3/high" },
  { model: "zai-glm-5-3", effort: "max", vision: false, ctx: 1_048_576, label: "glm-5.3/max" },
];
export const TOP = LADDER.length - 1;
export const LLM_WEIGHT = 0.8;
export const SCORE_TO_LEVEL: [number, number][] = [
  [1, 0],
  [3, 1],
  [4, 2],
  [5, 3],
  [6, 4],
  [8, 5],
  [10, 6],
];
export const VALID_EFFORT: Record<string, ReadonlySet<string>> = {
  "mistral-small-2603": new Set(["none", "high"]),
  "mistral-large-4-0": new Set(["low", "medium", "high"]),
  "deepseek-v4-1-flash-1017": new Set(["none", "low", "high", "max", "xhigh"]),
  "zai-glm-5-3": new Set(["low", "high", "max"]),
  "zai-glm-5-3-flash": new Set(["low", "high", "max"]),
};
export const AUTO_MODELS = new Map<string, [number, number]>([
  ["auto", [0, TOP]],
  ["auto-fast", [0, 2]],
  ["auto-max", [4, TOP]],
]);
const W = "\\p{L}\\p{N}_";
const HARD = new RegExp(
  `(?<![${W}])(debug[${W}]*|bug|refactor[${W}]*|architect[${W}]*|design|optimi[sz][${W}]*|prove|proof|algorithm[${W}]*|race condition|deadlock|security|vulnerab[${W}]*|migrat[${W}]*|implement[${W}]*|rewrite|analy[sz][${W}]*|investigat[${W}]*|root cause|concurren[${W}]*|performance|benchmark[${W}]*|navrhni|architektur[${W}]*|refaktor[${W}]*|oprav[${W}]*|optimaliz[${W}]*|analyz[${W}]*|implementuj|zjisti|přepiš|migrac[${W}]*|bezpečnost[${W}]*|chyb[${W}]*)(?![${W}])`,
  "giu",
);
const THINK = new RegExp(
  `step[- ]by[- ]step|think (hard|carefully)|carefully|rigorous|krok za krokem|důkladn[${W}]+|pořádně`,
  "iu",
);
const EASY = new RegExp(
  `^\\s*(hi|hello|hey|thanks?|ok|ahoj|čau|díky|dík)(?![${W}])|(?<![${W}])(translate|přelož[${W}]*|summari[sz]e|shrň[${W}]*|typo|rename|format|co je|what is|what's|kolik je)(?![${W}])`,
  "iu",
);
const TRACE = /Traceback \(most recent|^\s+at .+\(.+:\d+\)|\bException\b|\bpanic:|error\[E\d+\]|Segmentation fault/m;
const LIST = /(?:^\s*|\s)(\p{Nd}{1,2}[.)]|[-*•])\s+\S/gmu;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const truthy = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.length > 0;
  if (isRec(v)) return Object.keys(v).length > 0;
  return Boolean(v);
};
export const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Record<string, unknown> => isRec(p) && p.type === "text")
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join(" ");
  }
  return "";
};
const userMsgs = (body: ChatBody): Record<string, unknown>[] =>
  (Array.isArray(body.messages) ? body.messages : []).filter(isRec);
const lastUserText = (msgs: Record<string, unknown>[]): string => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user") return messageText(m.content);
  }
  return "";
};
const hasImage = (messages: Record<string, unknown>[]): boolean =>
  messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p) => isRec(p) && (p.type === "image_url" || p.type === "image")),
  );
export const cpLen = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const UNICODE_TRIM =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Unicode whitespace set
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
export const trimUnicode = (s: string): string => s.replace(UNICODE_TRIM, "");
const cpCmp = (a: string, b: string): number => {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};
const quoteList = (xs: string[]): string => `[${xs.map((x) => `'${x}'`).join(", ")}]`;
export const scoreRequest = (body: ChatBody): [number, string[], number, boolean] => {
  const msgs = userMsgs(body);
  const lastUser = lastUserText(msgs);
  let totalChars = 0;
  for (const m of msgs) totalChars += cpLen(messageText(m.content));
  const estTokens = Math.floor(totalChars / 4);
  let s = 0;
  const why: string[] = [];
  const add = (n: number, r: string): void => {
    s += n;
    why.push(`${n >= 0 ? "+" : ""}${n} ${r}`);
  };
  const n = cpLen(lastUser);
  if (n > 400) add(1, "long prompt");
  if (n > 1500) add(1, "very long prompt");
  if (n > 6000) add(1, "huge prompt");
  if (
    lastUser.includes("```") ||
    msgs
      .slice(-3)
      .map((m) => messageText(m.content))
      .join(" ")
      .includes("```")
  )
    add(1, "code");
  if (TRACE.test(lastUser)) add(1, "stack trace");
  const hard = new Set<string>();
  for (const m of lastUser.matchAll(HARD)) {
    const g = m[0];
    if (g !== undefined) hard.add(g.toLowerCase());
  }
  const sortedHard = [...hard].sort(cpCmp);
  if (hard.size >= 4) add(3, `many hard keywords ${quoteList(sortedHard.slice(0, 4))}`);
  else if (hard.size >= 3) add(2, `hard keywords ${quoteList(sortedHard.slice(0, 4))}`);
  else if (hard.size >= 1) add(1, `hard keyword ${sortedHard[0] ?? ""}`);
  if (THINK.test(lastUser)) add(1, "asks for careful reasoning");
  if ([...lastUser.matchAll(LIST)].length >= 3) add(1, "multi-part");
  if (truthy(body.tools)) add(2, "tools available");
  if (msgs.some((m) => m.role === "tool")) add(1, "agent loop");
  if (msgs.length > 10) add(1, "long conversation");
  if (estTokens > 30_000) add(1, "large context");
  if (estTokens > 100_000) add(1, "huge context");
  if (n < 200 && EASY.test(lastUser)) add(-1, "easy pattern");
  if (n < 40 && hard.size === 0) add(-1, "tiny prompt");
  return [Math.max(0, Math.min(10, s)), why, estTokens, hasImage(msgs)];
};
export const worthAsking = (body: ChatBody, score: number): boolean => {
  const last = lastUserText(userMsgs(body));
  return cpLen(trimUnicode(last)) >= 30 && score < 8;
};
const ladderAt = (i: number): Step => {
  const s = LADDER[((i % LADDER.length) + LADDER.length) % LADDER.length];
  if (!s) throw new RangeError("ladder index out of range");
  return s;
};
export const decide = (body: ChatBody, name = "auto", pressure = 1.0, llmScore?: number | null): Decision => {
  const [lo, hi] = AUTO_MODELS.get(name) ?? [0, TOP];
  let [score, why, tokens, image] = scoreRequest(body);
  if (llmScore !== undefined && llmScore !== null) {
    const blended = Math.round((1 - LLM_WEIGHT) * score + LLM_WEIGHT * llmScore);
    why.push(`tiny-LLM says ${llmScore}, heuristic ${score} -> ${blended}`);
    score = blended;
  }
  const hit = SCORE_TO_LEVEL.find(([b]) => score <= b);
  let level = hit ? hit[1] : TOP;
  level = Math.max(lo, Math.min(hi, level));
  if (truthy(body.tools) && level < 2 && score >= 4) {
    level = 2;
    why.push("tools+hard -> large-4");
  }
  const drop = pressure < 0.1 ? 2 : pressure < 0.25 ? 1 : 0;
  if (drop) {
    level = Math.max(Math.min(lo, 1), level - drop);
    why.push(`budget pressure ${Math.round(pressure * 100)}% -> -${drop}`);
  }
  let step = ladderAt(level);
  if (image && !step.vision) {
    while (!ladderAt(level).vision) level--;
    step = ladderAt(level);
    why.push("image -> vision model");
  }
  if (tokens > 200_000 && step.ctx < 400_000) {
    level = Math.max(level, 1);
    step = ladderAt(level);
    why.push("long context -> 1M model");
  }
  let effort = step.effort;
  const asked = body.reasoning_effort;
  const valid = VALID_EFFORT[step.model];
  if (typeof asked === "string" && asked && valid?.has(asked)) {
    effort = asked;
    why.push(`client effort ${asked} kept`);
  }
  return { model: step.model, effort, level, score, reason: why.join("; ") || "default", llm_score: llmScore ?? null };
};
export const apply = (body: ChatBody, d: Decision): ChatBody => {
  const out = { ...body };
  out.model = d.model;
  if (d.effort) out.reasoning_effort = d.effort;
  else delete out.reasoning_effort;
  return out;
};
export const decisionHeader = (d: Decision): string =>
  `${d.model};effort=${d.effort ?? "None"};level=${d.level};score=${d.score}${d.llm_score !== null ? `;llm=${d.llm_score}` : ""}`;
