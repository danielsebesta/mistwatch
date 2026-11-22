// Mistral returns the content of a reasoning model as a list of chunks ({type:"thinking"} and {type:"text"}).
// Clients that speak plain OpenAI chat (Vibe with backend "generic", used by Vibe Desktop) print that list as text.
// With the request header `x-mw-flat-content: 1` the proxy turns it into a string `content` plus `reasoning_content`.

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const FLAT_HEADER = "x-mw-flat-content";
export const wantsFlat = (h: Headers): boolean => {
  const v = (h.get(FLAT_HEADER) ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
};

const textOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("");
  return isRec(v) && typeof v.text === "string" ? v.text : "";
};

// Rewrites choices[].<key>.content in place when it is a chunk list; returns whether it changed anything.
const flattenChoices = (obj: Record<string, unknown>, key: "delta" | "message"): boolean => {
  if (!Array.isArray(obj.choices)) return false;
  let changed = false;
  for (const ch of obj.choices) {
    const m = isRec(ch) ? ch[key] : undefined;
    if (!isRec(m) || !Array.isArray(m.content)) continue;
    let text = "";
    let reasoning = "";
    for (const part of m.content) {
      if (typeof part === "string") text += part;
      else if (isRec(part) && part.type === "thinking") reasoning += textOf(part.thinking);
      else if (isRec(part) && part.type === "text") text += textOf(part.text);
    }
    m.content = text;
    if (reasoning !== "") m.reasoning_content = reasoning;
    changed = true;
  }
  return changed;
};

export const flattenJson = (raw: Uint8Array): Uint8Array => {
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (isRec(j) && flattenChoices(j, "message")) return new TextEncoder().encode(JSON.stringify(j));
  } catch {
    // not JSON: forwarded unchanged
  }
  return raw;
};

const flattenLine = (line: string): string => {
  const t = line.trimStart();
  if (!t.startsWith("data:") || t.includes("[DONE]")) return line;
  try {
    const j: unknown = JSON.parse(t.slice(5));
    if (isRec(j) && flattenChoices(j, "delta")) return `data: ${JSON.stringify(j)}`;
  } catch {
    // keep the line as it came
  }
  return line;
};

// Works line by line over the SSE stream; a line is only changed when its content was a chunk list.
export const flattenSse = (): TransformStream<Uint8Array, Uint8Array> => {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let tail = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      tail += dec.decode(chunk, { stream: true });
      const cut = tail.lastIndexOf("\n");
      if (cut < 0) return;
      const part = tail.slice(0, cut + 1);
      tail = tail.slice(cut + 1);
      ctl.enqueue(enc.encode(part.replace(/[^\n]*\n/g, (l) => `${flattenLine(l.slice(0, -1))}\n`)));
    },
    flush(ctl) {
      if (tail !== "") ctl.enqueue(enc.encode(flattenLine(tail)));
    },
  });
};
