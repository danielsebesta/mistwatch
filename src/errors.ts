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
  e.retryAfter === undefined ? {} : { "Retry-After": String(Math.max(Math.ceil(e.retryAfter), 1)) };
const secs = (n: number): number => Math.max(Math.ceil(n), 1);
export const errors = {
  auth: (): AppError => appError("mistwatch_auth", 401, "invalid proxy token"),
  budget: (retryAfter: number, pools: unknown): AppError => {
    const ra = secs(retryAfter);
    return appError("mistwatch_budget_exhausted", 429, "No account/pool has budget headroom right now.", {
      retryAfter: ra,
      extra: { pools, retry_after: ra },
    });
  },
  upstream: (): AppError => appError("mistwatch_upstream", 502, "all upstream attempts failed"),
  upstreamTimeout: (): AppError =>
    appError("mistwatch_upstream_timeout", 504, "upstream request timed out", { retryAfter: 1 }),
  tooLarge: (): AppError => appError("mistwatch_body_too_large", 413, "request body too large"),
  queueFull: (retryAfter = 1): AppError =>
    appError("mistwatch_queue_full", 503, "too many requests in flight", { retryAfter: secs(retryAfter) }),
  queueTimeout: (retryAfter = 1): AppError =>
    appError("mistwatch_queue_timeout", 503, "request timed out waiting or running", { retryAfter: secs(retryAfter) }),
  rateLimited: (retryAfter: number): AppError =>
    appError("mistwatch_rate_limited", 429, "rate limit exceeded", { retryAfter: secs(retryAfter) }),
  locked: (retryAfter: number): AppError =>
    appError("mistwatch_login_locked", 429, `Too many attempts, try again in ${secs(retryAfter)} s.`, {
      retryAfter: secs(retryAfter),
    }),
  badRequest: (message: string): AppError => appError("mistwatch_bad_request", 400, message),
  unauthorized: (message: string): AppError => appError("mistwatch_unauthorized", 401, message),
  forbidden: (message: string): AppError => appError("mistwatch_forbidden", 403, message),
  internal: (): AppError => appError("mistwatch_internal", 500, "internal error"),
};
