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
// The tiny model judges the request; the heuristic score only stands in when it cannot answer.
export const LLM_WEIGHT = 1;
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
// `auto` is the only router model. The two older names stay accepted so existing client configs keep working.
export const AUTO_MODELS: ReadonlySet<string> = new Set(["auto", "auto-fast", "auto-max"]);
export type Price = { input: number; output: number };
// Reasoning effort makes a model write more before it answers; this scales the output estimate.
const EFFORT_OUT: Record<string, number> = { none: 1, low: 1.5, medium: 2.5, high: 4, xhigh: 6, max: 6 };
const BASE_OUT_TOKENS = 1500;
const stepCost = (step: Step, inTokens: number, price: Price): number =>
  inTokens * price.input + BASE_OUT_TOKENS * (EFFORT_OUT[step.effort ?? "none"] ?? 1) * price.output;
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
// The tiny model judges every request that has any user text, however short: a few words can be a
// hard job in a large project.
export const worthAsking = (body: ChatBody): boolean => cpLen(trimUnicode(lastUserText(userMsgs(body)))) > 0;
const ladderAt = (i: number): Step => {
  const s = LADDER[((i % LADDER.length) + LADDER.length) % LADDER.length];
  if (!s) throw new RangeError("ladder index out of range");
  return s;
};
export const decide = (
  body: ChatBody,
  pressure = 1.0,
  llmScore?: number | null,
  priceOf?: (model: string) => Price | null,
): Decision => {
  let [score, why, tokens, image] = scoreRequest(body);
  if (llmScore !== undefined && llmScore !== null) {
    const blended = Math.round((1 - LLM_WEIGHT) * score + LLM_WEIGHT * llmScore);
    why.push(`tiny-LLM says ${llmScore}, heuristic ${score} -> ${blended}`);
    score = blended;
  }
  const hit = SCORE_TO_LEVEL.find(([b]) => score <= b);
  let level = hit ? hit[1] : TOP;
  if (truthy(body.tools) && level < 2 && score >= 4) {
    level = 2;
    why.push("tools+hard -> large-4");
  }
  const drop = pressure < 0.1 ? 2 : pressure < 0.25 ? 1 : 0;
  if (drop) {
    level = Math.max(0, level - drop);
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
  // The step one level up is stronger on the ladder. Take it when it costs less than the planned one
  // (a cheaper model at a stronger rung), but never while the budget is under pressure.
  const next = LADDER[level + 1];
  const price = priceOf?.(step.model);
  const nextPrice = next ? priceOf?.(next.model) : null;
  if (!drop && next && price && nextPrice && (!image || next.vision) && !(tokens > 200_000 && next.ctx < 400_000)) {
    const here = stepCost(step, tokens, price);
    const up = stepCost(next, tokens, nextPrice);
    if (up < here) {
      why.push(`${next.label} is stronger and cheaper than ${step.label}`);
      level += 1;
      step = next;
    }
  }
  // The client cannot choose the reasoning effort: it follows from the step the router picked.
  const effort = step.effort;
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
