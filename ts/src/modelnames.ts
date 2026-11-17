import { keyFor } from "./config.ts";
import type { DB } from "./db.ts";
import { LADDER } from "./router.ts";
import type { Account, CatalogEntry, FetchLike, ModelListing, NameSource } from "./types.ts";
export const REFRESH_AFTER_S = 12 * 3600;
export const BUILTIN: [RegExp, string][] = [
  [/^mistral-large-4(-0)?$|^mistral-large-latest$/, "Mistral Large 4"],
  [/^mistral-small-4$|^mistral-small-2603$|^mistral-small-latest$|^mistral-vibe-cli-fast$/, "Mistral Small 4"],
  [/^mistral-medium(-latest|-3-5|-3\.5)?$|^mistral-vibe-cli(-latest|-with-tools)?$/, "Mistral Medium 3.5"],
  [/^(zai-)?glm-5-3$|^zai-glm-(5|latest)$/, "GLM 5.3"],
  [/^(zai-)?glm-5-3-flash$/, "GLM 5.3 Flash"],
  [/^(zai-)?glm-5-2$/, "GLM 5.2"],
  [/^deepseek-v4-1-flash(-1017)?$/, "DeepSeek V4.1 Flash"],
  [/^ministral-3b(-latest|-2512)?$/, "Ministral 3 3B"],
  [/^ministral-8b(-latest|-2512)?$/, "Ministral 3 8B"],
  [/^ministral-14b(-latest|-2512)?$/, "Ministral 3 14B"],
  [/^codestral(-latest|-2508)?$|^mistral-code(-fim)?-latest$/, "Codestral"],
];
const BRANDS: Record<string, string> = {
  glm: "GLM",
  ocr: "OCR",
  tts: "TTS",
  gpt: "GPT",
  deepseek: "DeepSeek",
  llm: "LLM",
};
const DROP_PREFIX = new Set(["zai"]);
const VERSION = /^v?\d{1,2}$/;
const SIZE = /^\d+(\.\d+)?[bkm]$/;
const DIGITS = /^\d{1,2}$/;
const DIGITS4 = /^\d{4}$/;
const VNUM = /^v\d+(\.\d+)*$/;
export const builtin = (modelId: string): string | null => {
  const m = modelId.toLowerCase();
  for (const [rx, name] of BUILTIN) if (rx.test(m)) return name;
  return null;
};
const word = (tok: string): string => {
  const b = BRANDS[tok];
  if (b) return b;
  if (SIZE.test(tok)) return tok.toUpperCase();
  if (VNUM.test(tok)) return tok.toUpperCase();
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
};
export const autoname = (modelId: string): string => {
  const toks = modelId
    .trim()
    .toLowerCase()
    .split(/[-_ ]+/)
    .filter((t) => t);
  while (toks.length && DROP_PREFIX.has(toks[0] ?? "")) toks.shift();
  let suffix = "";
  if (toks.length && toks[toks.length - 1] === "latest") {
    toks.pop();
    suffix = " (latest)";
  } else if (toks.length > 1 && DIGITS4.test(toks[toks.length - 1] ?? "")) {
    suffix = ` (${toks.pop() ?? ""})`;
  }
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t === undefined) break;
    const next = toks[i + 1];
    if (VERSION.test(t) && next !== undefined && DIGITS.test(next)) {
      const parts = [t];
      i++;
      while (i < toks.length) {
        const x = toks[i];
        if (x === undefined || !DIGITS.test(x)) break;
        parts.push(x);
        i++;
      }
      while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
      out.push(parts.map((p) => (p.startsWith("v") ? p.toUpperCase() : p)).join("."));
      continue;
    }
    out.push(word(t));
    i++;
  }
  return out.join(" ") + suffix || modelId;
};
const looksHuman = (name: string): boolean => name.includes(" ") || [...name].some((c) => c !== c.toLowerCase());
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new TypeError("db: expected string");
  return v;
};
const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new TypeError("db: expected number");
};
const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const parseAliases = (v: unknown): string[] => {
  try {
    const o: unknown = JSON.parse(typeof v === "string" && v ? v : "[]");
    return Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
export const createModelNames = (db: DB) => {
  let over: Record<string, string> = {};
  let cat: Record<string, CatalogEntry> = {};
  const reload = (): void => {
    const o: Record<string, string> = {};
    for (const r of db.stmt("SELECT model_id, display FROM model_names").all()) o[str(r.model_id)] = str(r.display);
    over = o;
    const c: Record<string, CatalogEntry> = {};
    for (const r of db.stmt("SELECT model_id, name, aliases, description FROM model_catalog").all()) {
      c[str(r.model_id)] = {
        name: optStr(r.name),
        aliases: parseAliases(r.aliases),
        description: optStr(r.description),
      };
    }
    cat = c;
  };
  reload();
  const groupKey = (modelId: string): string => {
    const c = cat[modelId];
    return c?.name || modelId;
  };
  const resolve = (modelId: string | null | undefined): [string, NameSource] => {
    const m = (modelId ?? "").trim();
    if (!m) return ["(unknown)", "auto"];
    const key = groupKey(m);
    for (const k of [m, key]) {
      const o = over[k];
      if (o !== undefined) return [o, "custom"];
    }
    for (const k of [m, key]) {
      const b = builtin(k);
      if (b) return [b, "built-in"];
    }
    if (key !== m && looksHuman(key)) return [key, "mistral"];
    return [autoname(key), "auto"];
  };
  const refresh = async (fetchFn: FetchLike, base: string, key: string, now = Date.now() / 1000): Promise<number> => {
    const res = await fetchFn(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "mistwatch/0.1" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`upstream returned ${res.status}`);
    const data: unknown = await res.json();
    const rows: [string, string | null, string, string | null][] = [];
    const list = isRec(data) && Array.isArray(data.data) ? data.data : [];
    for (const m of list) {
      if (!isRec(m) || typeof m.id !== "string" || !m.id) continue;
      rows.push([
        m.id,
        optStr(m.name),
        JSON.stringify(Array.isArray(m.aliases) ? m.aliases : []),
        optStr(m.description),
      ]);
    }
    if (!rows.length) return 0;
    db.conn.exec("BEGIN");
    try {
      db.stmt("DELETE FROM model_catalog").run();
      const ins = db.stmt("INSERT INTO model_catalog(model_id, name, aliases, description) VALUES(?,?,?,?)");
      for (const r of rows) ins.run(r[0], r[1], r[2], r[3]);
      db.conn.exec("COMMIT");
    } catch (e) {
      db.conn.exec("ROLLBACK");
      throw e;
    }
    db.setMeta("catalog_ts", String(now));
    reload();
    return rows.length;
  };
  const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    reload,
    groupKey,
    setOverride: (modelId: string, display: string): void => {
      const d = display.trim();
      if (!d || d.length > 80 || [...d].some((c) => c.charCodeAt(0) < 32))
        throw new Error("Name must be 1-80 printable characters.");
      db.stmt(
        "INSERT INTO model_names(model_id, display) VALUES(?,?) ON CONFLICT(model_id) DO UPDATE SET display=excluded.display",
      ).run(groupKey(modelId), d);
      reload();
    },
    clearOverride: (modelId: string): void => {
      db.stmt("DELETE FROM model_names WHERE model_id IN (?,?)").run(modelId, groupKey(modelId));
      reload();
    },
    resolve,
    display: (modelId: string | null | undefined): string => resolve(modelId)[0],
    refresh,
    maybeRefresh: async (
      fetchFn: FetchLike,
      base: string,
      accounts: Account[],
      now = Date.now() / 1000,
    ): Promise<number | null> => {
      const last = Number.parseFloat(db.getMeta("catalog_ts") ?? "0") || 0;
      if (now - last < REFRESH_AFTER_S) return null;
      for (const a of accounts) {
        for (const pool of Object.keys(a.keys)) {
          try {
            return await refresh(fetchFn, base, keyFor(a, pool) ?? "", now);
          } catch {}
        }
      }
      return null;
    },
    listing: (includeAll = false): ModelListing[] => {
      const seen = new Map<string, [number, number]>();
      for (const r of db
        .stmt("SELECT model, COUNT(*) n, MAX(ts) m FROM ledger WHERE model IS NOT NULL GROUP BY model")
        .all()) {
        seen.set(str(r.model), [num(r.n), num(r.m)]);
      }
      const ids = new Set(seen.keys());
      for (const s of LADDER) ids.add(s.model);
      if (includeAll) for (const k of Object.keys(cat)) ids.add(k);
      const groups = new Map<string, { ids: string[]; calls: number; last: number }>();
      for (const i of [...ids].sort()) {
        const gk = groupKey(i);
        let g = groups.get(gk);
        if (!g) {
          g = { ids: [], calls: 0, last: 0 };
          groups.set(gk, g);
        }
        g.ids.push(i);
        const [n, last] = seen.get(i) ?? [0, 0];
        g.calls += n;
        g.last = Math.max(g.last, last);
      }
      for (const k of Object.keys(over)) if (!groups.has(k)) groups.set(k, { ids: [k], calls: 0, last: 0 });
      const out: ModelListing[] = [];
      for (const [k, g] of groups) {
        const first = g.ids[0];
        const [display, source] = resolve(first ?? null);
        const ce = first !== undefined ? cat[first] : undefined;
        out.push({
          key: k,
          ids: g.ids,
          display,
          source,
          calls: g.calls,
          last: g.last || null,
          description: ce?.description ?? null,
        });
      }
      return out.sort((a, b) => b.calls - a.calls || cmpStr(a.display.toLowerCase(), b.display.toLowerCase()));
    },
  };
};
export type ModelNames = ReturnType<typeof createModelNames>;
