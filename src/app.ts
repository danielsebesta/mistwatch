import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { llmsTxt } from "./agents.ts";
import { authClient, consoleForward } from "./compat.ts";
import { clientBaseUrl } from "./config.ts";
import { apiErrorBody, errorHeaders, errors, isAppError, proxyErrorBody, toAppError } from "./errors.ts";
import { createProxy } from "./proxy.ts";
import { localRequestAllowed, safePathSegment } from "./security.ts";
import { createState, type State } from "./state.ts";
import { startSyncLoop } from "./sync.ts";
import type { Config } from "./types.ts";
import { createWebApi, type WebApiOpts } from "./webapi.ts";
export type ProxyLike = {
  handle(req: Request): Promise<Response>;
  drain(graceMs?: number): Promise<void>;
};
export type AppOpts = { proxy?: ProxyLike; webDir?: string; apiOpts?: WebApiOpts };
const WEB_DIR = fileURLToPath(new URL("../dist/web", import.meta.url));
const ASSETS: Record<string, string> = {
  "favicon.svg": "image/svg+xml",
  "favicon.ico": "image/x-icon",
  "apple-touch-icon.png": "image/png",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "logo.svg": "image/svg+xml",
  "logo-dark.svg": "image/svg+xml",
  "mark.svg": "image/svg+xml",
  "site.webmanifest": "application/manifest+json",
};
const csp = (scriptSrc: string): string =>
  `default-src 'none'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
// Inline scripts are allowed by hash, not by 'unsafe-inline'.
const scriptHashes = (html: string): string[] =>
  [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) =>
      `'sha256-${createHash("sha256")
        .update(m[1] ?? "", "utf8")
        .digest("base64")}'`,
  );
export const createApp = (st: State, opts: AppOpts = {}): Hono => {
  const proxy = opts.proxy ?? createProxy(st);
  const webDir = opts.webDir ?? WEB_DIR;
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
  });
  app.use("*", async (c, next) => {
    const h = { host: c.req.header("host"), origin: c.req.header("origin") };
    if (localRequestAllowed(h, { port: st.cfg.port, extraHosts: st.cfg.allowed_hosts })) {
      await next();
      return;
    }
    const e = errors.forbiddenHost(st.cfg.port);
    const isApi = c.req.path === "/api" || c.req.path.startsWith("/api/");
    return new Response(JSON.stringify(isApi ? apiErrorBody(e) : proxyErrorBody(e)), {
      status: e.status,
      headers: { "content-type": "application/json", ...errorHeaders(e) },
    });
  });
  // The Vibe CLI reads the plan from console_base_url/api/vibe/whoami: your real account, forwarded.
  app.get("/api/vibe/whoami", (c) => {
    authClient(st, c.req.header("authorization") ?? null, c.req.header("x-api-key") ?? null);
    return consoleForward(st, "/api/vibe/whoami");
  });
  app.route("/api", createWebApi(st, opts.apiOpts));
  app.get("/llms.txt", (c) => {
    const base = new URL(c.req.url).origin;
    return c.body(llmsTxt(base), 200, { "content-type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  });
  app.get("/", (c) => {
    let html: string;
    try {
      html = readFileSync(join(webDir, "index.html"), "utf8");
    } catch {
      return c.text("Mistwatch web UI is not built (run `npm run build`).", 503);
    }
    return c.body(html, 200, {
      "content-type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": csp(["'self'", ...scriptHashes(html)].join(" ")),
    });
  });
  for (const [name, type] of Object.entries(ASSETS)) {
    if (!safePathSegment(name)) continue;
    app.get(`/${name}`, (c) => {
      let data: Buffer;
      try {
        data = readFileSync(join(webDir, name));
      } catch {
        return c.text("Not Found", 404);
      }
      return c.body(new Uint8Array(data), 200, { "content-type": type, "Cache-Control": "public, max-age=86400" });
    });
  }
  app.all("*", (c) => proxy.handle(c.req.raw));
  app.onError((e) => {
    const err = isAppError(e) ? e : toAppError(e);
    if (!isAppError(e)) console.error("app: unhandled error:", e);
    return new Response(JSON.stringify(proxyErrorBody(err)), {
      status: err.status,
      headers: { "content-type": "application/json", ...errorHeaders(err) },
    });
  });
  return app;
};
export type RunningServer = { port: number; close(): Promise<void> };
const closeAllConnections = (server: ServerType): void => {
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") server.closeAllConnections();
};
export const startServer = async (
  cfg: Config,
  opts: { signals?: boolean; graceMs?: number } = {},
): Promise<RunningServer> => {
  const st = createState(cfg);
  const proxy = createProxy(st);
  const app = createApp(st, { proxy });
  const stopSync = startSyncLoop(st);
  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port });
  await new Promise<void>((ok, fail) => {
    server.once("listening", ok);
    server.once("error", fail);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : cfg.port;
  console.log(`mistwatch: open ${clientBaseUrl({ host: cfg.host, port }, "/")} in your browser`);
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      stopSync();
      try {
        await proxy.drain(opts.graceMs ?? 10_000);
      } catch {
        // draining in-flight streams is best effort at shutdown
      }
      await new Promise<void>((res) => {
        const force = setTimeout(() => {
          closeAllConnections(server);
          res();
        }, 2_000);
        server.close(() => {
          clearTimeout(force);
          res();
        });
      });
      st.db.close();
    })();
    return closing;
  };
  if (opts.signals !== false) {
    const onSignal = () =>
      void close()
        .catch((e: unknown) => console.error("shutdown error:", e))
        .finally(() => process.exit(0));
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  return { port, close };
};
export const defaultWebDir = WEB_DIR;
