import { poolGrossRoom, poolPressure, poolRoom } from "./budget.ts";
import { rate as rateRequest } from "./classifier.ts";
import { keyFor } from "./config.ts";
import type { AppError } from "./errors.ts";
import {
  apiErrorBody,
  appError,
  asException,
  errorHeaders,
  errors,
  isAppError,
  proxyErrorBody,
  toAppError,
} from "./errors.ts";
import type { Reservation } from "./queue.ts";
import { createQueue } from "./queue.ts";
import { createRateLimiter } from "./ratelimit.ts";
import { AUTO_MODELS, apply, decide, decisionHeader, scoreRequest, truthy, worthAsking } from "./router.ts";
import {
  bodyWithinLimit,
  filterRequestHeaders,
  filterResponseHeaders,
  localRequestAllowed,
  readLimitedBody,
  redactSecrets,
} from "./security.ts";
import type { State } from "./state.ts";
import { blockKey, candidates, classify, exhaustedInfo } from "./state.ts";
import type { Account, ChatBody, Decision, PoolStatus } from "./types.ts";
export const BODY_LIMIT = 8 * 1024 * 1024;
export const CONNECT_S = 15;
export const TOTAL_S = 600;
export const BLOCK_S = 600;
export const BLOCK_429_S = 30;
export const ACCOUNTED = [
  "/v1/chat/completions",
  "/v1/fim/completions",
  "/v1/agents/completions",
  "/v1/embeddings",
  "/v1/ocr",
  "/v1/conversations",
  "/v1/moderations",
];
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pyInt = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  throw new TypeError("int() failed");
};
const estimateTokens = (chars: number): number => Math.max(Math.floor(chars / 4), 1);
const pickTruthy = (xs: unknown[]): unknown => {
  for (const x of xs) if (truthy(x)) return x;
  return 0;
};
const extractUsage = (obj: Record<string, unknown>): [number, number, number] | null => {
  const u = obj.usage;
  if (!isRec(u) || (!("prompt_tokens" in u) && !("completion_tokens" in u))) return null;
  const det = isRec(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const cached = pyInt(pickTruthy([u.num_cached_tokens, det.cached_tokens]));
  return [pyInt(pickTruthy([u.prompt_tokens])), pyInt(pickTruthy([u.completion_tokens])), cached];
};
const retryable = (e: unknown): boolean =>
  e instanceof TypeError && isRec(e.cause) && typeof e.cause.code === "string" && CONNECT_CODES.has(e.cause.code);
const respond = (body: ConstructorParameters<typeof Response>[0], status: number, headers: Headers): Response =>
  status === 204 || status === 304 ? new Response(null, { status, headers }) : new Response(body, { status, headers });
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, err) => {
    resolve = ok;
    reject = err;
  });
  return { promise, resolve, reject };
};
const pipe = (
  resp: Response,
  feed: ((c: Uint8Array) => void) | null,
  finish: () => void,
  signal: AbortSignal,
): ReadableStream<Uint8Array> => {
  const reader = resp.body?.getReader();
  let done = false;
  const fin = (): void => {
    if (done) return;
    done = true;
    void reader?.cancel().catch(() => undefined);
    finish();
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      signal.addEventListener(
        "abort",
        () => {
          if (done) return;
          c.error(signal.reason);
          fin();
        },
        { once: true },
      );
    },
    async pull(c) {
      if (reader === undefined) {
        c.close();
        fin();
        return;
      }
      try {
        const r = await reader.read();
        if (r.done) {
          c.close();
          fin();
          return;
        }
        c.enqueue(r.value);
        try {
          feed?.(r.value);
        } catch {
          // a parser bug must not break the client's stream
        }
      } catch (e) {
        c.error(e);
        fin();
      }
    },
    cancel() {
      fin();
    },
  });
};
const makeSseParser = (): {
  feed: (c: Uint8Array) => void;
  flush: () => void;
  usage: () => [number, number, number] | null;
  model: () => string | null;
  outChars: () => number;
} => {
  const dec = new TextDecoder();
  let tail = "";
  let usage: [number, number, number] | null = null;
  let model: string | null = null;
  let outChars = 0;
  const feed = (chunk: Uint8Array): void => {
    tail += dec.decode(chunk, { stream: true });
    const cut = tail.lastIndexOf("\n");
    if (cut < 0) return;
    const part = tail.slice(0, cut);
    tail = tail.slice(cut + 1);
    for (const raw of part.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("data:") || line.endsWith("[DONE]")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (!isRec(obj)) continue;
      const m = obj.model;
      if (typeof m === "string" && m !== "") model = m;
      const u = extractUsage(obj);
      if (u !== null) usage = u;
      const choices = obj.choices;
      if (!Array.isArray(choices)) continue;
      for (const ch of choices) {
        const d = isRec(ch) && isRec(ch.delta) ? ch.delta.content : undefined;
        if (typeof d === "string") outChars += d.length;
        else if (Array.isArray(d))
          for (const x of d) if (isRec(x) && typeof x.text === "string") outChars += x.text.length;
      }
    }
  };
  const flush = (): void => feed(new Uint8Array([10]));
  return { feed, flush, usage: () => usage, model: () => model, outChars: () => outChars };
};
export type ProxyOpts = {
  bodyLimit?: number | undefined;
  connectTimeoutS?: number | undefined;
  totalTimeoutS?: number | undefined;
  globalRate?: [number, number] | undefined;
  keyRate?: [number, number] | undefined;
  concurrency?: number | undefined;
  maxPending?: number | undefined;
};
export type Proxy = { handle(req: Request): Promise<Response>; drain(graceMs?: number): Promise<void> };
type Cand = { account: Account; pool: string; status: PoolStatus | null };
type Ctx = {
  res: Reservation;
  acct: string;
  pool: string;
  client: string | null;
  model: string | null;
  endpoint: string;
  estIn: number;
  t0: number;
};
export const createProxy = (st: State, opts: ProxyOpts = {}): Proxy => {
  const cfg = st.cfg;
  const bodyLimit = opts.bodyLimit ?? BODY_LIMIT;
  const connectMs = (opts.connectTimeoutS ?? CONNECT_S) * 1000;
  const totalMs = (opts.totalTimeoutS ?? TOTAL_S) * 1000;
  const [gLim, gWin] = opts.globalRate ?? [60, 60];
  const [kLim, kWin] = opts.keyRate ?? [30, 60];
  const globalRl = createRateLimiter({ limit: gLim, windowS: gWin });
  const keyRl = createRateLimiter({ limit: kLim, windowS: kWin });
  const queue = createQueue({ concurrency: opts.concurrency ?? 8, maxPending: opts.maxPending ?? 64 });
  const drainCtrl = new AbortController();
  const errResp = (e: AppError): Response =>
    Response.json(proxyErrorBody(e), { status: e.status, headers: errorHeaders(e) });
  const forward = async (req: Request): Promise<Response> => {
    if (!localRequestAllowed({ host: req.headers.get("host"), origin: req.headers.get("origin") }, { port: cfg.port }))
      throw asException(errors.forbidden("forbidden host"));
    const url = new URL(req.url);
    const urlPath = url.pathname;
    if (urlPath === "/api" || urlPath.startsWith("/api/"))
      return Response.json(apiErrorBody(appError("mistwatch_not_found", 404, "Not Found")), { status: 404 });
    let client: { id: number; name: string } | null = null;
    if (st.store.hasApiKeys()) {
      const auth = req.headers.get("authorization") ?? "";
      const tok = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : (req.headers.get("x-api-key") ?? "");
      const k = st.store.verifyApiKey(tok.trim());
      if (k === null) throw asException(errors.auth());
      client = k;
    }
    if (!bodyWithinLimit(req.headers.get("content-length"), bodyLimit)) throw asException(errors.tooLarge());
    const g = globalRl.check("");
    if (!g.allowed) throw asException(errors.rateLimited(g.retryAfter));
    const kr = keyRl.check(client === null ? "open" : String(client.id));
    if (!kr.allowed) throw asException(errors.rateLimited(kr.retryAfter));
    const body = await readLimitedBody(req.body, bodyLimit);
    const cls = classify(st, req.headers.get("user-agent") ?? "");
    const accounted = req.method === "POST" && ACCOUNTED.some((p) => urlPath === p || urlPath.startsWith(`${p}/`));
    let parsed: ChatBody = {};
    if (body.length > 0 && (req.headers.get("content-type") ?? "").includes("json")) {
      try {
        const j: unknown = JSON.parse(new TextDecoder().decode(body));
        if (isRec(j)) parsed = j;
      } catch {
        // python tolerates a non-json body here and forwards it unchanged
      }
    }
    let model = typeof parsed.model === "string" ? parsed.model : null;
    const wantStream = truthy(parsed.stream);
    const now = Date.now() / 1000;
    const cands: Cand[] = accounted
      ? candidates(st, cls, now)
      : ((): Cand[] => {
          const a = cfg.accounts.find((x) => x.enabled && Object.keys(x.keys).length > 0);
          return a === undefined ? [] : [{ account: a, pool: Object.keys(a.keys)[0] ?? cls, status: null }];
        })();
    if (cands.length === 0) {
      const info = exhaustedInfo(st, now);
      throw asException(errors.budget(info.retry_after, info.pools));
    }
    let routed: Decision | null = null;
    let sendBody = body;
    if (
      model !== null &&
      AUTO_MODELS.has(model) &&
      urlPath === "/v1/chat/completions" &&
      Object.keys(parsed).length > 0
    ) {
      const c0 = cands[0];
      if (c0 === undefined) throw asException(errors.internal());
      let llm: number | null = null;
      if (cfg.router.llm_classifier) {
        const h = scoreRequest(parsed)[0];
        const key0 = keyFor(c0.account, c0.pool);
        if (worthAsking(parsed, h) && key0) {
          const res = await rateRequest(
            st.fetch,
            cfg.upstream,
            key0,
            parsed,
            cfg.router.classifier_model,
            cfg.router.classifier_timeout_s,
          );
          if (res !== null) {
            const [s, pt, ct] = res;
            llm = s;
            if (pt || ct) {
              const [c] = st.prices.costEur(cfg.router.classifier_model, pt, ct);
              st.db.addLedger({
                ts: Date.now() / 1000,
                account: c0.account.name,
                pool: c0.pool,
                client: "(router)",
                model: cfg.router.classifier_model,
                endpoint: "router",
                prompt_tokens: pt,
                completion_tokens: ct,
                cost_eur: c,
                source: "proxy",
                status: 200,
              });
            }
          }
        }
      }
      routed = decide(parsed, model, c0.status === null ? 1.0 : poolPressure(c0.status), llm);
      parsed = apply(parsed, routed);
      sendBody = new TextEncoder().encode(JSON.stringify(parsed));
      model = routed.model;
      console.info(`auto -> ${decisionHeader(routed)} | ${routed.reason}`);
    }
    const [price] = st.prices.lookup(model);
    const estIn = estimateTokens(sendBody.length);
    const estOut = pyInt(pickTruthy([parsed.max_tokens, 1024]));
    const est = ((estIn * price.input + estOut * price.output) / 1e6) * cfg.usd_to_eur;
    const fwdPairs = filterRequestHeaders(req.headers);
    const t0 = Date.now() / 1000;
    const drainSig = AbortSignal.any([req.signal, drainCtrl.signal]);
    let lastResp: { status: number; body: Uint8Array; ct: string } | null = null;
    let roomSkips = 0;
    const book = (
      ctx: Ctx,
      usage: [number, number, number] | null,
      status: number,
      estFlag: boolean,
      o: { pages?: number | null; model?: string | null } = {},
    ): void => {
      try {
        const modelName = o.model || ctx.model;
        let cost: number;
        let exact: boolean;
        let p: number;
        let c: number;
        let cached: number;
        if (o.pages !== null && o.pages !== undefined) {
          cost = st.prices.pagesCostEur(o.pages);
          exact = true;
          p = o.pages;
          c = 0;
          cached = 0;
        } else if (usage !== null) {
          [p, c, cached] = usage;
          [cost, exact] = st.prices.costEur(modelName, p, c, cached);
        } else {
          return;
        }
        st.db.addLedger({
          ts: Date.now() / 1000,
          account: ctx.acct,
          pool: ctx.pool,
          client: ctx.client,
          model: modelName,
          endpoint: ctx.endpoint,
          prompt_tokens: p,
          completion_tokens: c,
          cached_tokens: cached,
          cost_eur: cost,
          source: "proxy",
          estimated: estFlag || !exact ? 1 : 0,
          status,
          latency_ms: Math.trunc((Date.now() / 1000 - ctx.t0) * 1000),
        });
      } finally {
        ctx.res.settle();
      }
    };
    const bookJson = (ctx: Ctx, status: number, content: Uint8Array): void => {
      if (status >= 400) {
        ctx.res.release();
        return;
      }
      let obj: unknown = null;
      try {
        obj = JSON.parse(new TextDecoder().decode(content));
      } catch {
        // body was not json: nothing to book
      }
      const rec = isRec(obj) ? obj : null;
      const ui = rec !== null && isRec(rec.usage_info) ? rec.usage_info : null;
      const pages = ui !== null && typeof ui.pages_processed === "number" ? ui.pages_processed : null;
      book(ctx, rec === null ? null : extractUsage(rec), status, false, {
        pages,
        model: rec !== null && typeof rec.model === "string" ? rec.model : null,
      });
    };
    for (const cand of cands) {
      let key: string | null;
      try {
        key = keyFor(cand.account, cand.pool);
      } catch (e) {
        console.error(`cannot resolve key for ${cand.account.name}:`, e);
        continue;
      }
      if (!key) continue;
      const fresh = cand.status === null ? null : st.engine.status(cand.account.name, cand.pool, Date.now() / 1000);
      const h = new Headers();
      try {
        for (const [k, v] of fwdPairs) h.set(k, v);
        h.set("authorization", `Bearer ${key}`);
      } catch {
        console.error(`invalid key for ${cand.account.name}/${cand.pool}`);
        continue;
      }
      const res = fresh === null ? null : st.engine.tryReserve(cand.account.name, cand.pool, est, poolGrossRoom(fresh));
      if (cand.status !== null && res === null) {
        roomSkips += 1;
        continue;
      }
      const ac = new AbortController();
      const onAbort = (s: AbortSignal): void => {
        if (s.aborted) ac.abort(s.reason);
        else s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
      };
      onAbort(req.signal);
      const upstreamErr = (e: unknown): unknown => {
        if (isAppError(e)) return e;
        if (ac.signal.aborted && isAppError(ac.signal.reason)) return ac.signal.reason;
        return asException(errors.upstream());
      };
      const held = deferred<void>();
      const early = deferred<Response>();
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const totalTimer = setTimeout(() => ac.abort(asException(errors.upstreamTimeout())), totalMs);
      totalTimer.unref();
      const heldResolve = (): void => held.resolve();
      const job = queue.run(
        async (sig) => {
          onAbort(sig);
          connectTimer = setTimeout(() => ac.abort(asException(errors.upstreamTimeout())), connectMs);
          connectTimer.unref();
          try {
            const resp = await st.fetch(`${cfg.upstream}${urlPath}${url.search}`, {
              method: req.method,
              headers: h,
              body: sendBody.length === 0 || req.method === "GET" || req.method === "HEAD" ? null : sendBody,
              signal: ac.signal,
              redirect: "manual",
            });
            early.resolve(resp);
            await held.promise;
          } catch (e) {
            early.reject(e);
            throw e;
          } finally {
            clearTimeout(connectTimer);
            clearTimeout(totalTimer);
          }
        },
        { signal: drainSig, timeoutMs: totalMs },
      );
      void job.then(undefined, (e: unknown) => early.reject(e));
      let resp: Response;
      try {
        resp = await early.promise;
      } catch (e) {
        res?.release();
        if (retryable(e) && !req.signal.aborted) {
          console.warn(`upstream connect error via ${cand.account.name}:`, e);
          continue;
        }
        throw upstreamErr(e);
      }
      clearTimeout(connectTimer);
      try {
        if (
          cand.status !== null &&
          (resp.status === 401 || resp.status === 402 || resp.status === 403 || resp.status === 429)
        ) {
          const raw = new Uint8Array(await resp.arrayBuffer());
          const text = new TextDecoder().decode(raw);
          console.warn(
            `upstream ${resp.status} via ${cand.account.name}/${cand.pool}:`,
            redactSecrets(text.slice(0, 300), [key]),
          );
          st.blockedUntil.set(
            blockKey(cand.account.name, cand.pool),
            Date.now() / 1000 + (resp.status === 429 ? BLOCK_429_S : BLOCK_S),
          );
          lastResp = { status: resp.status, body: raw, ct: resp.headers.get("content-type") ?? "application/json" };
          res?.release();
          heldResolve();
          continue;
        }
        const hdrs = new Headers();
        for (const [k, v] of filterResponseHeaders(resp.headers)) hdrs.set(k, v);
        hdrs.set("x-mw-account", cand.account.name);
        hdrs.set("x-mw-pool", cand.pool);
        if (routed !== null) hdrs.set("x-mw-routed", decisionHeader(routed));
        if (cand.status !== null) hdrs.set("x-mw-room-eur", poolRoom(cand.status).toFixed(4));
        if (cand.status === null) {
          if (resp.body === null || resp.status === 204 || resp.status === 304) {
            heldResolve();
            return new Response(null, { status: resp.status, headers: hdrs });
          }
          return respond(pipe(resp, null, heldResolve, ac.signal), resp.status, hdrs);
        }
        if (res === null) throw asException(errors.internal());
        const ctx: Ctx = {
          res,
          acct: cand.account.name,
          pool: cand.pool,
          client: client?.name ?? null,
          model,
          endpoint: urlPath,
          estIn,
          t0,
        };
        if (wantStream && resp.status === 200) {
          const sse = makeSseParser();
          return respond(
            pipe(
              resp,
              sse.feed,
              () => {
                try {
                  sse.flush();
                } catch {
                  // keep what was parsed so far
                }
                try {
                  book(ctx, sse.usage() ?? [estIn, estimateTokens(sse.outChars()), 0], 200, sse.usage() === null, {
                    model: sse.model(),
                  });
                } finally {
                  heldResolve();
                }
              },
              ac.signal,
            ),
            resp.status,
            hdrs,
          );
        }
        const content = new Uint8Array(await resp.arrayBuffer());
        bookJson(ctx, resp.status, content);
        heldResolve();
        return respond(content, resp.status, hdrs);
      } catch (e) {
        res?.release();
        heldResolve();
        throw upstreamErr(e);
      }
    }
    if (lastResp !== null) return respond(lastResp.body, lastResp.status, new Headers({ "content-type": lastResp.ct }));
    if (roomSkips === cands.length) {
      const info = exhaustedInfo(st, Date.now() / 1000);
      throw asException(errors.budget(info.retry_after, info.pools));
    }
    throw asException(errors.upstream());
  };
  const handle = async (req: Request): Promise<Response> => {
    try {
      return await forward(req);
    } catch (e) {
      return errResp(toAppError(e));
    }
  };
  const drain = async (graceMs = 5000): Promise<void> => {
    const until = Date.now() + graceMs;
    while ((queue.active > 0 || queue.pending > 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    drainCtrl.abort(asException(errors.internal()));
    const end = Date.now() + 1000;
    while (queue.active > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };
  return { handle, drain };
};
