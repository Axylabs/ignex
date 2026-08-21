/**
 * @fileoverview Differential parity harness — interpreted `createApp().handler()`
 * vs the AOT-compiled `Bun.serve` server.
 *
 * The same request, driven through both pipeline implementations with the SAME
 * plugin stack (cors / compression / security / rate-limit / session + i18n),
 * must produce identical status, body and headers. This is the stability
 * contract: any divergence here is a dev-vs-prod behavior gap (broken flow or
 * data corruption) worth fixing, not just a test failure.
 *
 * Session cookies carry a random per-server sid value, so `set-cookie` is
 * compared by cookie NAMES (deterministic) rather than raw values; explicitly
 * set cookies (e.g. `seen`) are compared by value.
 */

import {
  compression,
  cors,
  createApp,
  createI18n,
  type IgnexContext,
  rateLimit,
  security,
  session,
} from "@ignex/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "../../core/test/helpers/inject";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";

let srv: BootedServer;

/** The interpreted app mirrors the matrix fixture's plugin stack. */
const makeInterpretedApp = (handler: (ctx: IgnexContext) => unknown) => {
  const i18n = createI18n(
    { en: { greeting: "Hello" }, es: { greeting: "Hola" }, fr: { greeting: "Bonjour" } },
    { fallbackLocale: "en", defaultLocale: "en" },
  );
  return createApp({
    plugins: [
      cors({ origin: "*" }),
      compression(),
      security(),
      rateLimit({ maxRequests: 5, windowMs: 60_000, skip: (ctx) => ctx.path !== "/ratelimit" }),
      session({ secret: "matrix-fixture-secret", createIfMissing: true }),
    ],
    lifecycle: { request: [{ fn: i18n.middleware() }] },
    handler: handler as (ctx: IgnexContext) => Promise<Response> | Response,
  });
};

interface ParityCase {
  name: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  handler: (ctx: IgnexContext) => unknown;
}

const CASES: ParityCase[] = [
  {
    name: "echo-get",
    method: "GET",
    path: "/echo?a=1&b=two&q=hello%20world",
    handler: (ctx) =>
      ctx.json({ method: ctx.method, path: ctx.path, query: Object.fromEntries(ctx.query) }),
  },
  {
    name: "echo-post-json",
    method: "POST",
    path: "/echo",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: 1, b: [1, 2, 3] }),
    handler: (ctx) =>
      ctx.json({ method: ctx.method, path: ctx.path, query: Object.fromEntries(ctx.query) }),
  },
  {
    name: "boom",
    method: "GET",
    path: "/boom",
    handler: () => {
      throw new Error("kaboom");
    },
  },
  {
    name: "cookies",
    method: "GET",
    path: "/cookies",
    headers: { cookie: "a=1; b=2" },
    handler: (ctx) => {
      const seen = Object.keys(ctx.cookie);
      ctx.set.cookie = { ...ctx.set.cookie, seen: { value: "1" } };
      return ctx.json({ seen });
    },
  },
  {
    name: "text-post",
    method: "POST",
    path: "/text",
    headers: { "content-type": "text/plain" },
    body: "hello world",
    handler: async (ctx) => ctx.json({ text: await ctx.body.text() }),
  },
  {
    name: "form-post",
    method: "POST",
    path: "/form",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "a=1&b=two%20words",
    handler: async (ctx) => ctx.json({ fields: await ctx.body.form() }),
  },
  {
    name: "raw-post",
    method: "POST",
    path: "/raw",
    headers: { "content-type": "application/octet-stream" },
    body: "\u0000\u0001hello",
    handler: async (ctx) => {
      const buf = await ctx.body.arrayBuffer();
      const first = new TextDecoder().decode(buf.slice(0, 8));
      return ctx.json({ bytes: buf.byteLength, first });
    },
  },
  {
    name: "headers-echo",
    method: "GET",
    path: "/headers",
    // `accept-language` is sent explicitly: undici's `fetch` (used for the
    // compiled side under vitest) adds a default `accept-language: *` that
    // `new Request` (interpreted side) does not, so without an explicit value
    // the two sides would receive different requests.
    headers: {
      "x-test": "yes",
      "x-multi": "one",
      "accept-language": "en",
      authorization: "Bearer tok",
    },
    handler: (ctx) => {
      const ECHO = [
        "x-test",
        "x-multi",
        "if-none-match",
        "if-modified-since",
        "accept-language",
        "authorization",
        "content-type",
      ];
      const headers: Record<string, string> = {};
      for (const name of ECHO) {
        const value = ctx.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return ctx.json({ headers });
    },
  },
];

/** Headers whose exact value must match across the two paths. */
const COMPARE_HEADERS = [
  "content-type",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "access-control-allow-origin",
  "location",
  "allow",
];

const cookieNames = (headers: Headers): string[] => {
  const values = headers.getSetCookie?.() ?? [];
  if (values.length === 0) {
    const single = headers.get("set-cookie");
    if (single) values.push(single);
  }
  return values.map((c) => c.split("=")[0] as string).sort();
};

const runCase = async (c: ParityCase) => {
  const compiledInit: RequestInit = { method: c.method };
  if (c.headers !== undefined) compiledInit.headers = c.headers;
  if (c.body !== undefined) compiledInit.body = c.body;
  const compiled = await fetch(`${srv.base}${c.path}`, compiledInit);
  const compiledBody = await compiled.text();

  const interpretedInit: Parameters<typeof inject>[1] = { method: c.method, url: c.path };
  if (c.headers !== undefined) interpretedInit.headers = c.headers;
  if (c.body !== undefined) interpretedInit.body = c.body;
  const interpreted = await inject(makeInterpretedApp(c.handler), interpretedInit);
  const interpretedBody = await interpreted.text();

  return { compiled, compiledBody, interpreted, interpretedBody };
};

beforeAll(async () => {
  // Force a fresh build so parity compares against CURRENT source — a stale
  // `dist/__server.js` would produce false divergences.
  srv = await bootServer(MATRIX_FIXTURE, { rebuild: true });
});

afterAll(() => srv.close());

describe("interpreted vs compiled parity", () => {
  for (const c of CASES) {
    it(`${c.name}: identical status, body and headers`, async () => {
      const { compiled, compiledBody, interpreted, interpretedBody } = await runCase(c);

      expect(interpreted.status).toBe(compiled.status);
      expect(interpretedBody).toBe(compiledBody);
      for (const h of COMPARE_HEADERS) {
        expect(interpreted.headers.get(h)).toBe(compiled.headers.get(h));
      }
      // Cookie NAMES must match (values for session sid are random per server).
      expect(cookieNames(interpreted.headers)).toEqual(cookieNames(compiled.headers));
    });
  }

  it("explicitly-set cookie values are byte-identical (seen=1)", async () => {
    const { compiled, interpreted } = await runCase(CASES[3]!);
    const sc = (h: Headers): string[] => h.getSetCookie?.() ?? [h.get("set-cookie") ?? ""];
    const compiledSeen = sc(compiled.headers).find((c) => c.startsWith("seen="));
    const interpretedSeen = sc(interpreted.headers).find((c) => c.startsWith("seen="));
    expect(compiledSeen).toBe("seen=1");
    expect(interpretedSeen).toBe("seen=1");
  });
});
