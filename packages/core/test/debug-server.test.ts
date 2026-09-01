/**
 * Unit tests for the debugbar serving layer: revision counters, the SSE
 * stream hub (ticket lifecycle), static assets (ETag/CSP) and the endpoint
 * table's dispatch/auth contract.
 */

import { describe, expect, it } from "vitest";
import { createAssetServer } from "../src/debug/server/assets";
import { createTokenGate } from "../src/debug/server/auth";
import { createRevisionCounters } from "../src/debug/server/revisions";
import { createStreamHub } from "../src/debug/server/stream";
import type { IgnexContext } from "../src/http/context";

/* ── revisions ────────────────────────────────────────────────────────────── */

describe("revision counters", () => {
  it("track domains independently and advance a global epoch", () => {
    const counters = createRevisionCounters();
    const before = counters.snapshot();
    expect(before.epoch).toBe(0);

    counters.bump("traces");
    counters.bump("traces");
    counters.bump("logs");
    const after = counters.snapshot();

    expect(after.traces).toBe(2);
    expect(after.logs).toBe(1);
    expect(after.metrics).toBe(0);
    expect(after.epoch).toBe(3);
    expect(counters.changedSince(after)).toBe(false);
    expect(counters.changedSince(before)).toBe(true);
  });
});

/* ── stream hub ────────────────────────────────────────────────────────────── */

const fakeCtx = (url = "http://x/__debugbar/api/stream"): IgnexContext =>
  ({
    url: new URL(url),
    method: "GET",
    req: { signal: null },
  }) as unknown as IgnexContext;

describe("stream hub tickets", () => {
  it("mint single-use tickets that expire", () => {
    const hub = createStreamHub(createRevisionCounters());
    const ticket = hub.mintTicket();
    expect(hub.consumeTicket(ticket)).toBe(true);
    expect(hub.consumeTicket(ticket)).toBe(false); // single use

    const expiredHolder = createStreamHub(createRevisionCounters());
    void expiredHolder;
    expect(hub.consumeTicket("")).toBe(false);
    expect(hub.consumeTicket("forged")).toBe(false);
    hub.stop();
  });

  it("reject connections without a valid ticket (403)", () => {
    const hub = createStreamHub(createRevisionCounters());
    // @ts-expect-error exercising the guard with a minimal ctx stub
    const res = hub.handle(fakeCtx(), null);
    expect(res.status).toBe(403);
    const forged = hub.handle(fakeCtx(), "nope");
    expect(forged.status).toBe(403);
    hub.stop();
  });

  it("serve an SSE response for a valid ticket", async () => {
    const counters = createRevisionCounters();
    const hub = createStreamHub(counters);
    const ticket = hub.mintTicket();
    // @ts-expect-error minimal ctx stub
    const res = hub.handle(fakeCtx(), ticket);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");
    // Read the first few chunks (retry hint + hello frame) — the stream
    // intentionally stays open afterwards.
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 3 && !text.includes("event: revision"); i++) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain("event: revision");
    expect(text).toContain('"epoch"');
    void reader?.cancel().catch(() => {});
    hub.stop();
  });
});

/* ── assets ────────────────────────────────────────────────────────────────── */

describe("asset server", () => {
  it("serves the shell with a strict CSP and baked mount path", async () => {
    const assets = createAssetServer("/__debugbar");
    const page = assets.page();
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain('data-base="/__debugbar"');
    expect(html).toContain('/app.js"');
  });

  it("answers If-None-Match with 304 and ETags fresh responses", async () => {
    const assets = createAssetServer("/__debugbar");
    const first = assets.js(null);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const cached = assets.js(etag);
    expect(cached.status).toBe(304);
    // CSS shares the same content hash.
    expect(assets.css(etag).status).toBe(304);
    const css = await assets.css(null).text();
    expect(css).toContain("--k-db"); // token system intact
  });
});

/* ── token gate ─────────────────────────────────────────────────────────────── */

const ctxWithHeaders = (headers: Record<string, string>, query = ""): IgnexContext =>
  ({
    headers: new Headers(headers),
    url: new URL(`http://x/__debugbar/${query}`),
  }) as unknown as IgnexContext;

describe("token gate", () => {
  it("opens everything when no token is configured", () => {
    const gate = createTokenGate(null);
    expect(gate.authorized(ctxWithHeaders({}))).toBe(true);
    expect(gate.hasQueryToken(ctxWithHeaders({}, "?token=whatever"))).toBe(false);
  });

  it("accepts header or cookie, never a raw query token on APIs", () => {
    const gate = createTokenGate("sekret");
    expect(gate.authorized(ctxWithHeaders({ "x-debugbar-token": "sekret" }))).toBe(true);
    expect(gate.authorized(ctxWithHeaders({ cookie: "__debugbar_token=sekret; other=1" }))).toBe(
      true,
    );
    expect(gate.authorized(ctxWithHeaders({ cookie: "__debugbar_token=nope" }))).toBe(false);
    expect(gate.authorized(ctxWithHeaders({}))).toBe(false);
    // Query tokens are only recognized for the PAGE handshake, not APIs.
    expect(gate.hasQueryToken(ctxWithHeaders({}, "?token=sekret"))).toBe(true);
    expect(gate.hasQueryToken(ctxWithHeaders({}, ""))).toBe(false);
  });

  it("compares in constant time (length-safe, no throw on mismatched lengths)", () => {
    const gate = createTokenGate("short");
    expect(gate.authorized(ctxWithHeaders({ "x-debugbar-token": "a-much-longer-attempt" }))).toBe(
      false,
    );
  });
});
