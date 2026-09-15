/**
 * `trustProxy` must reach the CONTEXT, not just the plugin that declares it.
 *
 * `security({ trustProxy: true })` used to influence only its own HSTS decision.
 * `ctx.ip` reads `ContextOptions.trustProxy`, which no plugin could set — so the
 * header branch was unreachable in compiled apps (where nothing ever set the
 * option) while interpreted apps honoured it. These tests pin the declaration
 * that closes the gap, and the resolver both paths now share.
 */

import { describe, expect, it } from "vitest";
import { resolveClientIp } from "../src/http/context";
import { collectContextOptions } from "../src/lifecycle/plugin";
import { security } from "../src/plugins/security";

/** A stand-in for `Bun.serve`'s return value, as far as IP resolution goes. */
const fakeServer = (address: string | undefined) => ({
  requestIP: () => (address === undefined ? null : { address }),
});

describe("collectContextOptions", () => {
  it("is undefined when nothing declares context options", () => {
    expect(collectContextOptions([])).toBeUndefined();
    expect(collectContextOptions([security()])).toBeUndefined();
  });

  it("reads a plugin's declarative `contextOptions`", () => {
    expect(collectContextOptions([security({ trustProxy: true })])).toEqual({ trustProxy: true });
  });

  it("cannot be switched back off by another plugin", () => {
    // The setting means "this deployment sits behind a proxy": one declaration
    // settles it, and no plugin can prove the opposite.
    const merged = collectContextOptions([security({ trustProxy: true }), security()]);
    expect(merged).toEqual({ trustProxy: true });
  });

  it("ignores non-plugin entries and flattens nested lists", () => {
    expect(collectContextOptions([null, 42, "nope"])).toBeUndefined();
    expect(collectContextOptions([[security({ trustProxy: true })], undefined])).toEqual({
      trustProxy: true,
    });
  });
});

describe("security() declares its trust-proxy setting", () => {
  it("declares it when enabled", () => {
    expect(security({ trustProxy: true }).contextOptions).toEqual({ trustProxy: true });
  });

  it("does not declare it by default", () => {
    // Absent, not `{ trustProxy: false }` — an undeclared option must leave an
    // explicit app-level setting authoritative.
    expect(security().contextOptions).toBeUndefined();
  });
});

describe("resolveClientIp", () => {
  it("prefers x-real-ip when the deployment trusts a proxy", () => {
    const req = new Request("http://x/", { headers: { "x-real-ip": "203.0.113.7" } });
    expect(resolveClientIp(fakeServer("10.0.0.9"), req, true)).toBe("203.0.113.7");
  });

  it("falls back to the LAST x-forwarded-for hop when trusted", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.9" },
    });
    expect(resolveClientIp(fakeServer(undefined), req, true)).toBe("10.0.0.9");
  });

  it("ignores forwarded headers when the deployment does not trust a proxy", () => {
    // The client supplied these; without `trustProxy` they must not be believed.
    const req = new Request("http://x/", {
      headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" },
    });
    expect(resolveClientIp(fakeServer("10.0.0.9"), req, false)).toBe("10.0.0.9");
  });

  it("uses the socket address when a trusted deployment sends no header", () => {
    expect(resolveClientIp(fakeServer("10.0.0.9"), new Request("http://x/"), true)).toBe(
      "10.0.0.9",
    );
  });

  it('reports "anonymous" when no address can be resolved', () => {
    expect(resolveClientIp(fakeServer(undefined), new Request("http://x/"), false)).toBe(
      "anonymous",
    );
    expect(resolveClientIp(null, new Request("http://x/"), false)).toBe("anonymous");
  });
});
