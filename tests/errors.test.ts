import { describe, expect, it } from "vitest";
import {
  apiErrorBody,
  appError,
  asException,
  errorHeaders,
  errors,
  isAppError,
  proxyErrorBody,
  toAppError,
} from "../src/errors.ts";

describe("AppError", () => {
  it("appError builds a plain data object", () => {
    const e = appError("x_code", 400, "bad input", { retryAfter: 3, extra: { a: 1 } });
    expect(e).toEqual({ code: "x_code", status: 400, message: "bad input", retryAfter: 3, extra: { a: 1 } });
    expect(appError("x", 500, "m")).toEqual({
      code: "x",
      status: 500,
      message: "m",
      retryAfter: undefined,
      extra: undefined,
    });
  });
  it("isAppError accepts objects and exceptions, rejects the rest", () => {
    expect(isAppError(errors.internal())).toBe(true);
    expect(isAppError(asException(errors.internal()))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError("x")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError({ code: "a", status: 200 })).toBe(false);
  });
  it("asException makes a throwable Error carrying the fields", () => {
    const x = asException(errors.tooLarge());
    expect(x instanceof Error).toBe(true);
    expect(x.name).toBe("mistwatch_body_too_large");
    expect(x.code).toBe("mistwatch_body_too_large");
    expect(x.status).toBe(413);
    expect(x.message).toBe("The request body is too large.");
    expect(x.stack).toBeTypeOf("string");
  });
  it("toAppError normalises unknown throws without leaking internals", () => {
    const mine = errors.auth();
    expect(toAppError(mine)).toBe(mine);
    const secret = "/home/user/secret.db";
    const n = toAppError(new Error(`sqlite broke at ${secret}`));
    expect(n.code).toBe("mistwatch_internal");
    expect(n.status).toBe(500);
    expect(JSON.stringify(proxyErrorBody(n))).not.toContain(secret);
    expect(toAppError("string error").status).toBe(500);
    expect(toAppError(undefined).code).toBe("mistwatch_internal");
    const fb = errors.forbidden("nope");
    expect(toAppError(new Error("x"), fb)).toBe(fb);
  });
});
describe("bodies and headers", () => {
  it("proxyErrorBody has the {error:{type,message,...}} shape", () => {
    expect(proxyErrorBody(errors.auth())).toEqual({
      error: {
        type: "mistwatch_auth",
        message:
          "Missing or invalid Mistwatch key. Create one under API keys in the web UI and send it as Authorization: Bearer mw-...",
      },
    });
    expect(proxyErrorBody(errors.upstream())).toEqual({
      error: {
        type: "mistwatch_upstream",
        message:
          "Could not get a usable answer from Mistral on any account (network error or rejected key). Check the connection and the account keys in the web UI, then try again.",
      },
    });
    const b = proxyErrorBody(errors.budget(42, [{ account: "a" }]));
    expect(b.error.type).toBe("mistwatch_budget_exhausted");
    expect(b.error.retry_after).toBe(42);
    expect(b.error.pools).toEqual([{ account: "a" }]);
  });
  it("apiErrorBody matches the FastAPI {detail} shape", () => {
    expect(apiErrorBody(errors.unauthorized("You are not signed in."))).toEqual({ detail: "You are not signed in." });
    expect(apiErrorBody(errors.locked(60)).detail).toBe("Too many attempts, try again in 60 s.");
  });
  it("errorHeaders emits Retry-After ceiled to >= 1", () => {
    expect(errorHeaders(errors.internal())).toEqual({});
    expect(errorHeaders(errors.budget(41.2, []))).toEqual({
      "Retry-After": "42",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "42",
    });
    expect(errorHeaders(errors.rateLimited(0))).toEqual({
      "Retry-After": "1",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "1",
    });
  });
  it("constructor statuses", () => {
    expect(errors.auth().status).toBe(401);
    expect(errors.budget(1, []).status).toBe(429);
    expect(errors.upstream().status).toBe(502);
    expect(errors.upstreamTimeout().status).toBe(504);
    expect(errors.tooLarge().status).toBe(413);
    expect(errors.queueFull().status).toBe(503);
    expect(errors.queueTimeout().status).toBe(503);
    expect(errors.rateLimited(5).status).toBe(429);
    expect(errors.locked(5).status).toBe(429);
    expect(errors.badRequest("x").status).toBe(400);
    expect(errors.forbidden("x").status).toBe(403);
    expect(errors.internal().status).toBe(500);
  });
});
