/**
 * @fileoverview Static-default passthrough (`__decorateWithDefaults`).
 *
 * When an app declares app-invariant static response headers — plugin
 * `responseDefaults` (e.g. `security()`) plus `server.headers` — the compiler
 * bakes them into `__DEFAULT_HEADERS`. `__withBody` applies them at response
 * CONSTRUCTION, but raw `Response` passthroughs, the 404/405 fallback, the
 * OPTIONS preflight, error responses and pre-handler short-circuits never go
 * through it (Bun 1.4.2 ignores `Bun.serve({ headers })`, so there is no runtime
 * sink). `__decorateWithDefaults` fills that gap: it adds only the missing
 * defaults in place and marks the response decorated so the decorating plugin
 * chain skips its static loop.
 *
 * These tests evaluate the emitted helper exactly as the generated server does
 * (via `new Function`, the same harness as `response-memo.test.ts`) against the
 * REAL `markDecoratedResponse`/`isDecoratedResponse` registry, so the
 * interaction with the plugin skip check is pinned end-to-end.
 */

import { describe, expect, it } from "vitest";
import { HELPER_SOURCES } from "../../compiler/src/phases/codegen/helpers";
import { isDecoratedResponse, markDecoratedResponse } from "../src/http/finalize";

const DEFAULTS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

interface Evaled {
  __withBody: (payload: Uint8Array | null, type: string, init?: ResponseInit) => Response;
  __decorateWithDefaults: (response: Response) => Response;
}

const evaluate = (defaults: Record<string, string> | null): Evaled => {
  const body = [HELPER_SOURCES.__withBody, HELPER_SOURCES.__decorateWithDefaults].join("\n\n");
  const prelude = `const __DEFAULT_HEADERS = ${
    defaults === null ? "null" : JSON.stringify(defaults)
  };
const markDecoratedResponse = __mark;
const isDecoratedResponse = __is;`;
  const factory = new Function(
    "__mark",
    "__is",
    `${prelude}\n${body}\nreturn { __withBody, __decorateWithDefaults };`,
  ) as (mark: typeof markDecoratedResponse, is: typeof isDecoratedResponse) => Evaled;
  return factory(markDecoratedResponse, isDecoratedResponse);
};

const evaled = evaluate(DEFAULTS);
const evaledNoDefaults = evaluate(null);

describe("__decorateWithDefaults", () => {
  it("adds every static default to a raw response (the 404/OPTIONS gap)", () => {
    const raw = new Response("not found", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    const decorated = evaled.__decorateWithDefaults(raw);
    expect(decorated).toBe(raw);
    expect(decorated.headers.get("content-type")).toBe("application/json");
    expect(decorated.headers.get("x-frame-options")).toBe("DENY");
    expect(decorated.headers.get("x-content-type-options")).toBe("nosniff");
    expect(decorated.headers.get("referrer-policy")).toBe("no-referrer");
    expect(decorated.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(decorated.status).toBe(404);
  });

  it("preserves the response's own status, body and headers", async () => {
    const raw = new Response("hello", {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "text/plain", "x-frame-options": "SAMEORIGIN" },
    });
    const decorated = evaled.__decorateWithDefaults(raw);
    // A route-specific value wins over the app default.
    expect(decorated.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(decorated.status).toBe(201);
    expect(decorated.statusText).toBe("Created");
    // ...while the defaults it did not set are filled in.
    expect(decorated.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await decorated.text()).toBe("hello");
  });

  it("keeps multiple set-cookie values intact (in-place mutation)", async () => {
    const raw = new Response("ok", { headers: { "content-type": "text/plain" } });
    raw.headers.append("set-cookie", "a=1; Path=/");
    raw.headers.append("set-cookie", "b=2; Path=/");
    const decorated = evaled.__decorateWithDefaults(raw);
    const cookies = decorated.headers.getSetCookie();
    expect(cookies).toContain("a=1; Path=/");
    expect(cookies).toContain("b=2; Path=/");
    expect(decorated.headers.get("x-frame-options")).toBe("DENY");
  });

  it("is idempotent and returns an already-decorated response unchanged", () => {
    const raw = new Response(null, { status: 204 });
    const once = evaled.__decorateWithDefaults(raw);
    expect(isDecoratedResponse(once)).toBe(true);
    const twice = evaled.__decorateWithDefaults(once);
    expect(twice).toBe(once);
  });

  it("does NOT re-touch a response `__withBody` already decorated", () => {
    // `__withBody` bakes the defaults + content-length and registers the
    // response; the decorator must return it by identity (the hot-path probe).
    const built = evaled.__withBody("hello", "text/plain");
    expect(isDecoratedResponse(built)).toBe(true);
    expect(evaled.__decorateWithDefaults(built)).toBe(built);
    expect(built.headers.get("x-frame-options")).toBe("DENY");
  });

  it("is a pass-through no-op when the app declares no static defaults", () => {
    const raw = new Response("ok", { status: 404 });
    const out = evaledNoDefaults.__decorateWithDefaults(raw);
    expect(out).toBe(raw);
    expect(out.headers.get("x-frame-options")).toBeNull();
    expect(isDecoratedResponse(out)).toBe(false);
  });
});
