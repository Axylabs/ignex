/**
 * @fileoverview Unit tests for the trusted-Host header validator
 * (`trusted-host.ts`).
 *
 * Host-header poisoning — a request with a forged `Host` redirecting an app's
 * absolute-URL generation (password-reset links, OAuth callbacks, cache keys)
 * to an attacker's server — is a classic OWASP vector. The validator gives an
 * app a small, auditable allowlist to check `ctx.headers.get("host")` against.
 */

import { describe, expect, it } from "vitest";
import { trustedHost } from "../src/http/trusted-host";

const allow = (list: readonly string[]) => ({ allowlist: list });

describe("trustedHost — accepted", () => {
  it("matches a bare hostname", () => {
    expect(trustedHost("example.com", allow(["example.com"]))).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(trustedHost("EXAMPLE.COM", allow(["example.com"]))).toBe(true);
  });

  it("accepts any port when the entry has none (proxied hosts)", () => {
    expect(trustedHost("example.com:8080", allow(["example.com"]))).toBe(true);
    expect(trustedHost("example.com:443", allow(["example.com"]))).toBe(true);
  });

  it("pinpoints the port when the entry specifies one", () => {
    expect(trustedHost("example.com:8080", allow(["example.com:8080"]))).toBe(true);
  });

  it("compares the hostname even after a port", () => {
    expect(trustedHost("example.com:9999", allow(["example.com:8080"]))).toBe(false);
  });

  it("handles IPv4 literals", () => {
    expect(trustedHost("127.0.0.1", allow(["127.0.0.1"]))).toBe(true);
  });

  it("handles bracketed IPv6 literals with and without port", () => {
    expect(trustedHost("[::1]", allow(["::1"]))).toBe(true);
    expect(trustedHost("[::1]:3000", allow(["::1"]))).toBe(true);
    expect(trustedHost("[::1]:3000", allow(["[::1]:3000"]))).toBe(true);
    expect(trustedHost("::1", allow(["::1"]))).toBe(true);
    expect(trustedHost("[fe80::1]:443", allow(["fe80::1"]))).toBe(true);
  });

  it("matches any allowlist entry", () => {
    expect(trustedHost("b.example", allow(["a.example", "b.example"]))).toBe(true);
  });
});

describe("trustedHost — rejected", () => {
  it.each([null, undefined, ""])("rejects deficient host %p", (host) => {
    expect(trustedHost(host, allow(["example.com"]))).toBe(false);
  });

  it("rejects a host outside the allowlist", () => {
    expect(trustedHost("evil.com", allow(["example.com"]))).toBe(false);
  });

  it("rejects a subdomain of an allowlisted domain", () => {
    expect(trustedHost("example.com.evil.com", allow(["example.com"]))).toBe(false);
    expect(trustedHost("www.example.com", allow(["example.com"]))).toBe(false);
  });

  it("rejects CR/LF header-injection hosts", () => {
    expect(trustedHost("example.com\r\nx-injected: 1", allow(["example.com"]))).toBe(false);
    expect(trustedHost("example.com\nset-cookie: a=1", allow(["example.com"]))).toBe(false);
  });

  it("rejects whitespace and empty allowlists", () => {
    expect(trustedHost(" example.com", allow(["example.com"]))).toBe(false);
    expect(trustedHost("example.com", allow([]))).toBe(false);
  });
});
