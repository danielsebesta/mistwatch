import { describe, expect, it } from "vitest";
import {
  bodyWithinLimit,
  filterRequestHeaders,
  filterResponseHeaders,
  hashPasswordAsync,
  hostAllowed,
  limitBodyStream,
  localRequestAllowed,
  originAllowed,
  randomToken,
  readLimitedBody,
  redactSecrets,
  safeEqual,
  safePathSegment,
  verifyPasswordAsync,
} from "../src/security.ts";
import { hashPassword, verifyPassword } from "../src/store.ts";

const OPTS = { port: 8787 };
const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
describe("host and origin allowlist", () => {
  it("accepts loopback hosts on the configured port", () => {
    for (const h of ["127.0.0.1:8787", "localhost:8787", "[::1]:8787", "127.0.0.1", "localhost.", "LOCALHOST:8787"])
      expect(hostAllowed(h, OPTS), h).toBe(true);
  });
  it("rejects foreign hosts, wrong ports, and junk", () => {
    for (const h of [
      "evil.com",
      "127.0.0.1.evil.com",
      "localhost.evil.com",
      "127.0.0.1:9999",
      "localhost:",
      "localhost:0x1f",
      "127.0.0.1:-1",
      "[::1",
      "::1",
      "foo bar",
      "",
      null,
      undefined,
    ])
      expect(hostAllowed(h, OPTS), JSON.stringify(h)).toBe(false);
  });
  it("extraHosts widens the allowlist", () => {
    const opts = { port: 8787, extraHosts: ["mistwatch.local"] };
    expect(hostAllowed("mistwatch.local:8787", opts)).toBe(true);
    expect(hostAllowed("mistwatch.local:8787", OPTS)).toBe(false);
  });
  it("origin: absent allowed, null rejected, non-local rejected", () => {
    expect(originAllowed(null, OPTS)).toBe(true);
    expect(originAllowed(undefined, OPTS)).toBe(true);
    expect(originAllowed("null", OPTS)).toBe(false);
    expect(originAllowed("http://localhost:8787", OPTS)).toBe(true);
    expect(originAllowed("http://127.0.0.1:8787", OPTS)).toBe(true);
    expect(originAllowed("https://[::1]:8787", OPTS)).toBe(true);
    expect(originAllowed("http://localhost", OPTS)).toBe(false); // wrong port
    expect(originAllowed("http://localhost:80", OPTS)).toBe(false);
    expect(originAllowed("http://evil.com", OPTS)).toBe(false);
    expect(originAllowed("http://127.0.0.1.evil.com:8787", OPTS)).toBe(false);
    expect(originAllowed("file:///etc/passwd", OPTS)).toBe(false);
    expect(originAllowed("http://user:pw@localhost:8787", OPTS)).toBe(false);
    expect(originAllowed("not a url", OPTS)).toBe(false);
  });
  it("localRequestAllowed requires both", () => {
    expect(localRequestAllowed({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, OPTS)).toBe(true);
    expect(localRequestAllowed({ host: "127.0.0.1:8787", origin: "http://evil.com" }, OPTS)).toBe(false);
    expect(localRequestAllowed({ host: "evil.com", origin: undefined }, OPTS)).toBe(false);
    expect(localRequestAllowed({ host: "127.0.0.1:8787", origin: undefined }, OPTS)).toBe(true);
  });
});
describe("configured extra hosts", () => {
  const extra = { port: 8787, extraHosts: ["mw.example.com"] };
  it("allows a listed host and origin on any port, nothing else", () => {
    expect(hostAllowed("mw.example.com", extra)).toBe(true);
    expect(originAllowed("https://mw.example.com", extra)).toBe(true);
    expect(originAllowed("https://evil.example.com", extra)).toBe(false);
    expect(hostAllowed("mw.example.com.evil.net", extra)).toBe(false);
    expect(originAllowed("https://mw.example.com", { port: 8787 })).toBe(false);
    expect(originAllowed("http://127.0.0.1:9999", extra)).toBe(false);
  });
  it("matches a listed IPv6 literal", () => {
    const v6 = { port: 8787, extraHosts: ["fd00::5"] };
    expect(hostAllowed("[fd00::5]:8787", v6)).toBe(true);
    expect(originAllowed("http://[fd00::5]:8787", v6)).toBe(true);
    expect(hostAllowed("[fd00::6]:8787", v6)).toBe(false);
  });
  it("lets a listed local name through on a forwarded port", () => {
    const fwd = { port: 8787, extraHosts: ["localhost"] };
    expect(hostAllowed("localhost:9000", fwd)).toBe(true);
    expect(originAllowed("http://localhost:9000", fwd)).toBe(true);
    expect(hostAllowed("localhost:9000", { port: 8787 })).toBe(false);
  });
});
describe("constant-time equality and tokens", () => {
  it("safeEqual compares without length leaks", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(safeEqual(new Uint8Array([1, 2]), "abc")).toBe(false);
  });
  it("randomToken: base64url, right length, unique", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
describe("header filtering", () => {
  it("request: strips hop-by-hop, secrets, cookies, x-mw", () => {
    const h = new Headers({
      authorization: "Bearer mw-secret",
      "x-api-key": "mw-secret",
      cookie: "mw_session=abc",
      "x-mw": "1",
      "x-mw-trace": "yes",
      connection: "X-Junk, keep-alive",
      "x-junk": "drop me via connection token",
      "content-length": "42",
      "user-agent": "test",
      "content-type": "application/json",
    });
    const out = filterRequestHeaders(h);
    const names = out.map(([k]) => k).sort();
    expect(names).toEqual(["content-type", "user-agent"]);
  });
  it("request: extraDrop", () => {
    const out = filterRequestHeaders(
      [
        ["x-real-ip", "1.2.3.4"],
        ["a", "1"],
      ],
      ["X-Real-IP"],
    );
    expect(out).toEqual([["a", "1"]]);
  });
  it("response: strips hop-by-hop, connection tokens and set-cookie", () => {
    const pairs: [string, string][] = [
      ["content-type", "text/event-stream"],
      ["x-ratelimit-remaining", "10"],
      ["set-cookie", "x=y"],
      ["connection", "X-Extra"],
      ["x-extra", "bye"],
      ["transfer-encoding", "chunked"],
    ];
    const names = filterResponseHeaders(pairs).map(([k]) => k);
    expect(names).toEqual(["content-type", "x-ratelimit-remaining"]);
  });
});
describe("body size guard", () => {
  it("bodyWithinLimit trusts a sane content-length only", () => {
    expect(bodyWithinLimit("100", 100)).toBe(true);
    expect(bodyWithinLimit("101", 100)).toBe(false);
    expect(bodyWithinLimit(null, 1)).toBe(true);
    expect(bodyWithinLimit("junk", 1)).toBe(true); // stream guard still applies
  });
  it("readLimitedBody concatenates within the limit", async () => {
    const out = await readLimitedBody(streamOf(bytes("abc"), bytes("def")), 6);
    expect(new TextDecoder().decode(out)).toBe("abcdef");
    expect((await readLimitedBody(null, 1)).byteLength).toBe(0);
  });
  it("readLimitedBody throws a typed 413 over the limit", async () => {
    await expect(readLimitedBody(streamOf(bytes("abc"), bytes("def")), 3)).rejects.toMatchObject({
      code: "mistwatch_body_too_large",
      status: 413,
    });
  });
  it("limitBodyStream passes through then errors", async () => {
    const ok = streamOf(bytes("ab"), bytes("cd")).pipeThrough(limitBodyStream(4));
    const parts: number[] = [];
    for await (const c of ok) parts.push(c.byteLength);
    expect(parts).toEqual([2, 2]);
    const bad = streamOf(bytes("ab"), bytes("cd"), bytes("e")).pipeThrough(limitBodyStream(4));
    await expect(async () => {
      for await (const c of bad) parts.push(c.byteLength);
    }).rejects.toMatchObject({ code: "mistwatch_body_too_large" });
  });
});
describe("scrypt password hashing", () => {
  const PY = "scrypt$15$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$w9y9AHNnRyPSo3L1zpEwRMSl1/otj3VqtyHUKgZVG6E=";
  it("verifies a hash produced by Python hashlib.scrypt", async () => {
    expect(await verifyPasswordAsync("correct-horse", PY)).toBe(true);
    expect(await verifyPasswordAsync("wrong-horse", PY)).toBe(false);
  });
  it("roundtrips and interops with the sync store helpers", async () => {
    const h = await hashPasswordAsync("my password");
    expect(h.startsWith("scrypt$15$8$1$")).toBe(true);
    expect(await verifyPasswordAsync("my password", h)).toBe(true);
    expect(await verifyPasswordAsync("other", h)).toBe(false);
    expect(verifyPassword("my password", h)).toBe(true); // store.ts sync verify accepts ours
    expect(await verifyPasswordAsync("my password", hashPassword("my password"))).toBe(true); // and vice versa
  });
  it("rejects malformed and DoS-padded stored hashes", async () => {
    expect(await verifyPasswordAsync("x", "scrypt$garbage")).toBe(false);
    expect(await verifyPasswordAsync("x", "other$15$8$1$AAAA$BBBB")).toBe(false);
    expect(await verifyPasswordAsync("x", "scrypt$-1$8$1$AAAA$BBBB")).toBe(false);
    expect(await verifyPasswordAsync("x", "scrypt$15$8$1$!!!$BBBB")).toBe(false);
    expect(await verifyPasswordAsync("x", "scrypt$99$8$1$MDEy$AAAA")).toBe(false); // n=2^99
    expect(await verifyPasswordAsync("x", "scrypt$22$64$1$MDEy$AAAA")).toBe(false); // mem bound
    expect(await verifyPasswordAsync("x", "scrypt$15$8$1$MDEy$AAAA")).toBe(false); // dklen != 32
  });
});
describe("log redaction and paths", () => {
  it("redacts mw- keys, bearer tokens and caller secrets", () => {
    const key = "mw-abcdefghijklmnopqrstuvwxyz012345";
    const out = redactSecrets(`auth Bearer ${key} Bearer abc.def.ghi-jkl mistral-key-12345 tiny`, [
      "mistral-key-12345",
      "tiny", // too short to be a secret, skipped
    ]);
    expect(out).not.toContain(key);
    expect(out).not.toContain("mistral-key-12345");
    expect(out).toContain("tiny");
    expect(out).toContain("[redacted]");
    expect(redactSecrets("nothing here")).toBe("nothing here");
  });
  it("safePathSegment rejects traversal and separators", () => {
    for (const ok of ["favicon.svg", "icon-192.png", "a.b_c-d"]) expect(safePathSegment(ok), ok).toBe(true);
    for (const bad of ["..", "../x", "a/b", "a\\b", ".hidden", "", "a b", "a%2e", "index.html/evil"])
      expect(safePathSegment(bad), bad).toBe(false);
  });
});
