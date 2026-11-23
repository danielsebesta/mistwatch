export type AppError = {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly retryAfter?: number | undefined;
  readonly extra?: Record<string, unknown> | undefined;
};
export type AppErrorOpts = {
  retryAfter?: number | undefined;
  extra?: Record<string, unknown> | undefined;
};
export type AppException = Error & AppError;
export const appError = (code: string, status: number, message: string, opts: AppErrorOpts = {}): AppError => ({
  code,
  status,
  message,
  retryAfter: opts.retryAfter,
  extra: opts.extra,
});
export const asException = (e: AppError): AppException => {
  const x = Object.assign(new Error(e.message), e);
  x.name = e.code;
  return x;
};
export const isAppError = (v: unknown): v is AppError => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === "string" && typeof o.status === "number" && typeof o.message === "string";
};
export const toAppError = (v: unknown, fallback?: AppError): AppError =>
  isAppError(v) ? v : (fallback ?? errors.internal());
export const proxyErrorBody = (e: AppError): { error: Record<string, unknown> } => ({
  error: { type: e.code, message: e.message, ...(e.extra ?? {}) },
});
export const apiErrorBody = (e: AppError): { detail: string } => ({ detail: e.message });
export const errorHeaders = (e: AppError): Record<string, string> =>
  e.retryAfter === undefined
    ? {}
    : {
        "Retry-After": String(Math.max(Math.ceil(e.retryAfter), 1)),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(Math.max(Math.ceil(e.retryAfter), 1)),
      };
const secs = (n: number): number => Math.max(Math.ceil(n), 1);
const waitText = (s: number): string => {
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
};
const sizeLabel = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
export const errors = {
  auth: (): AppError =>
    appError(
      "mistwatch_auth",
      401,
      "Missing or invalid Mistwatch key. Create one under API keys in the web UI and send it as Authorization: Bearer mw-...",
    ),
  budget: (retryAfter: number, pools: unknown, now = Date.now()): AppError => {
    const ra = secs(retryAfter);
    const resetAt = new Date(now + ra * 1000).toISOString();
    // Clients that only show the message (OpenCode, for one) cannot read the headers.
    return appError(
      "mistwatch_budget_exhausted",
      429,
      `No account has budget room right now. Budget frees up in ${waitText(ra)} (at ${resetAt}); retry after that.`,
      {
        retryAfter: ra,
        extra: { pools, retry_after: ra, reset_at: resetAt },
      },
    );
  },
  upstream: (): AppError =>
    appError(
      "mistwatch_upstream",
      502,
      "Could not get a usable answer from Mistral on any account (network error or rejected key). Check the connection and the account keys in the web UI, then try again.",
    ),
  upstreamTimeout: (seconds?: number, phase: "first_byte" | "total" | "idle" = "total"): AppError => {
    const t = seconds === undefined ? "" : ` within ${waitText(seconds)}`;
    const msg =
      phase === "first_byte"
        ? `Mistral did not start answering${t}. Try again.`
        : phase === "idle"
          ? `Mistral sent nothing for ${seconds === undefined ? "too long" : waitText(seconds)}. Try again.`
          : `Mistral did not finish${t}. Try again.`;
    return appError("mistwatch_upstream_timeout", 504, msg, { retryAfter: 1 });
  },
  tooLarge: (limitBytes?: number, hint?: string): AppError =>
    appError(
      "mistwatch_body_too_large",
      413,
      limitBytes === undefined
        ? "The request body is too large."
        : `The request body is larger than ${sizeLabel(limitBytes)}.${hint === undefined ? "" : ` ${hint}`}`,
    ),
  queueFull: (retryAfter = 1): AppError =>
    appError("mistwatch_queue_full", 503, "Mistwatch is busy with too many requests. Retry in a moment.", {
      retryAfter: secs(retryAfter),
    }),
  queueTimeout: (retryAfter = 1): AppError =>
    appError("mistwatch_queue_timeout", 503, "The request waited or ran too long. Retry in a moment.", {
      retryAfter: secs(retryAfter),
    }),
  rateLimited: (retryAfter: number): AppError =>
    appError("mistwatch_rate_limited", 429, "Too many requests. Slow down and retry after the Retry-After delay.", {
      retryAfter: secs(retryAfter),
    }),
  locked: (retryAfter: number): AppError =>
    appError("mistwatch_login_locked", 429, `Too many attempts, try again in ${secs(retryAfter)} s.`, {
      retryAfter: secs(retryAfter),
    }),
  badRequest: (message: string): AppError => appError("mistwatch_bad_request", 400, message),
  unauthorized: (message: string): AppError => appError("mistwatch_unauthorized", 401, message),
  forbiddenHost: (port: number): AppError =>
    appError(
      "mistwatch_forbidden",
      403,
      `This address is not allowed. Open Mistwatch at http://127.0.0.1:${port}/ or add this host to allowed_hosts under [server] in config.toml.`,
    ),
  notVibe: (ua: string): AppError =>
    appError(
      "mistwatch_not_vibe",
      403,
      `Mistwatch serves only Vibe and the Vibe CLI (User-Agent "${ua.slice(0, 60)}" is neither). Since 1 December 2026 Mistral counts other tools towards the API allowance, not Vibe. Set vibe_only = false under [limits] in config.toml to allow other clients.`,
    ),
  forbidden: (message: string): AppError => appError("mistwatch_forbidden", 403, message),
  shuttingDown: (): AppError =>
    appError("mistwatch_shutting_down", 503, "Mistwatch is shutting down. Retry in a moment.", { retryAfter: 1 }),
  internal: (): AppError =>
    appError("mistwatch_internal", 500, "Something went wrong inside Mistwatch. Check the server log."),
};
