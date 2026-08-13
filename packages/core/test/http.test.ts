/**
 * HTTP layer edge-case tests — file serving, conditional requests, headers,
 * cookies, query parsing and lazy body parsing.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isNotModified } from "../src/http/conditional.js";
import {
  appendVary,
  HOP_BY_HOP_HEADERS,
  mergeHeaders,
  stripHopByHopHeaders,
} from "../src/http/headers.js";
import { head, options } from "../src/http/route.js";
import {
  applySet,
  BodyParseError,
  createLazyBody,
  parseCookieString,
  parseQuery,
  parseQueryFromURL,
  safeJoin,
  sendFile,
  serializeCookie,
} from "../src/index.js";
import { ForbiddenError, NotFoundError } from "../src/platform/errors.js";

describe("route DSL head/options", () => {
  it("head attaches its schema and is invocable", () => {
    const handler = head((ctx) => ctx.text(""), { query: { type: "object" } });
    expect((handler as unknown as { schema?: unknown }).schema).toEqual({
      query: { type: "object" },
    });
  });

  it("options attaches no schema when omitted", () => {
    const handler = options((ctx) => ctx.text(""));
    expect((handler as unknown as { schema?: unknown }).schema).toBeUndefined();
  });
});

describe("safeJoin", () => {
  it("resolves nested paths within the root", () => {
    expect(safeJoin("/var/public", "img/logo.png")).toBe(join("/var/public", "img", "logo.png"));
  });

  it("blocks path traversal", () => {
    expect(() => safeJoin("/var/public", "../etc/passwd")).toThrow(ForbiddenError);
    expect(() => safeJoin("/var/public", "/etc/passwd")).toThrow(ForbiddenError);
    expect(() => safeJoin("/var/public", "a/../../etc/passwd")).toThrow(ForbiddenError);
  });
});

describe("isNotModified", () => {
  const etag = 'W/"abc"';
  const lastModified = "Wed, 21 Oct 2026 07:28:00 GMT";

  it("matches an exact etag", () => {
    const req = new Request("http://x/", { headers: { "if-none-match": etag } });
    expect(isNotModified(req, etag)).toBe(true);
  });

  it("matches an etag among multiple tags", () => {
    const req = new Request("http://x/", {
      headers: { "if-none-match": '"a", W/"b", W/"abc"' },
    });
    expect(isNotModified(req, etag)).toBe(true);
  });

  it("trims whitespace around tags", () => {
    const req = new Request("http://x/", {
      headers: { "if-none-match": '  W/"abc"  , "other"  ' },
    });
    expect(isNotModified(req, etag)).toBe(true);
  });

  it("does not match a different etag", () => {
    const req = new Request("http://x/", { headers: { "if-none-match": '"xyz"' } });
    expect(isNotModified(req, etag)).toBe(false);
  });

  it("honors if-modified-since when >= last-modified", () => {
    const req = new Request("http://x/", {
      headers: { "if-modified-since": "Wed, 21 Oct 2026 08:00:00 GMT" },
    });
    expect(isNotModified(req, undefined, lastModified)).toBe(true);
  });

  it("ignores if-modified-since when earlier than last-modified", () => {
    const req = new Request("http://x/", {
      headers: { "if-modified-since": "Wed, 21 Oct 2026 07:00:00 GMT" },
    });
    expect(isNotModified(req, undefined, lastModified)).toBe(false);
  });

  it("returns false without preconditions", () => {
    expect(isNotModified(new Request("http://x/"), etag, lastModified)).toBe(false);
  });
});

describe("parseQuery", () => {
  it("parses single keys", () => {
    expect(parseQuery("a=1&b=2")).toEqual({ a: "1", b: "2" });
  });

  it("groups duplicate keys into arrays", () => {
    expect(parseQuery("a=1&a=2&a=3")).toEqual({ a: ["1", "2", "3"] });
  });

  it("handles empty values and URL decoding", () => {
    expect(parseQuery("q=&x=hello%20world")).toEqual({ q: "", x: "hello world" });
  });

  it("parseQueryFromURL ignores the path", () => {
    expect(parseQueryFromURL("/search?q=1&q=2")).toEqual({ q: ["1", "2"] });
    expect(parseQueryFromURL("/noquery")).toEqual({});
  });
});

describe("cache/conditional helpers via mergeHeaders + hop-by-hop", () => {
  it("removes every hop-by-hop header", () => {
    const headers = new Headers({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      upgrade: "h2c",
      "content-length": "123",
      "x-custom": "keep",
    });
    const out = stripHopByHopHeaders(headers);
    for (const h of HOP_BY_HOP_HEADERS) {
      expect(out.has(h)).toBe(false);
    }
    expect(out.get("x-custom")).toBe("keep");
  });

  it("appendVary de-duplicates case-insensitively", () => {
    const h = new Headers();
    appendVary(h, "Origin");
    appendVary(h, "origin");
    appendVary(h, "Accept-Encoding");
    expect(h.get("vary")).toBe("Origin, Accept-Encoding");
  });
});

describe("mergeHeaders", () => {
  it("handles a Headers init", () => {
    const out = new Headers(mergeHeaders({ "x-a": "1" }, new Headers({ "x-b": "2" })));
    expect(out.get("x-a")).toBe("1");
    expect(out.get("x-b")).toBe("2");
  });

  it("handles array init and skips undefined values", () => {
    const out = new Headers(
      mergeHeaders({}, [
        ["x-a", "1"],
        ["x-b", undefined],
        ["x-c", "3"],
      ]),
    );
    expect(out.get("x-a")).toBe("1");
    expect(out.has("x-b")).toBe(false);
    expect(out.get("x-c")).toBe("3");
  });

  it("handles object init and skips undefined values", () => {
    const out = new Headers(mergeHeaders({}, { "x-a": "1", "x-b": undefined }));
    expect(out.get("x-a")).toBe("1");
    expect(out.has("x-b")).toBe(false);
  });

  it("returns base when init is undefined", () => {
    const out = new Headers(mergeHeaders({ "x-a": "1" }));
    expect(out.get("x-a")).toBe("1");
  });
});

describe("applySet", () => {
  it("returns the original response unchanged when nothing was mutated", () => {
    const response = new Response("ok");
    expect(applySet(response, { headers: {} })).toBe(response);
  });

  it("applies status, headers and cookies", () => {
    const response = applySet(new Response("ok"), {
      status: 201,
      headers: { "x-a": "1" },
      cookie: { sid: { value: "abc", httpOnly: true } },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-a")).toBe("1");
    expect(response.headers.get("set-cookie")).toContain("sid=abc");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("handles redirect before other mutations", () => {
    const response = applySet(new Response("ok"), {
      redirect: "http://localhost/login",
      status: 301,
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });

  it("skips null/undefined header values and appends arrays", () => {
    const response = applySet(new Response("ok"), {
      headers: { "x-null": null, "x-set": "1", "x-multi": ["a", "b"] },
    });
    expect(response.headers.has("x-null")).toBe(false);
    expect(response.headers.get("x-set")).toBe("1");
    const multi = response.headers.get("x-multi");
    expect(multi).toContain("a");
    expect(multi).toContain("b");
  });

  it("sets the trace request id when trace is enabled", () => {
    const response = applySet(new Response("ok"), { headers: {} }, "req-1", true);
    expect(response.headers.get("x-request-id")).toBe("req-1");
  });
});

describe("cookies", () => {
  it("parses and URL-decodes values", () => {
    expect(parseCookieString("a=1; b=hello%20world")).toEqual({ a: "1", b: "hello world" });
  });

  it("returns an empty record for null/empty input", () => {
    expect(parseCookieString(null)).toEqual({});
    expect(parseCookieString("")).toEqual({});
  });

  it("caps the number of parsed cookies (DoS guard)", () => {
    const many = Array.from({ length: 500 }, (_, i) => `k${i}=v${i}`).join("; ");
    const parsed = parseCookieString(many);
    expect(Object.keys(parsed).length).toBe(100);
  });

  it("serializes a cookie with attributes", () => {
    const value = serializeCookie({
      sid: { value: "abc", httpOnly: true, sameSite: "lax", path: "/" },
    });
    expect(Array.isArray(value) ? value[0] : value).toContain("sid=abc");
    expect(Array.isArray(value) ? value[0] : value).toContain("HttpOnly");
    expect(Array.isArray(value) ? value[0] : value).toContain("SameSite=Lax");
  });

  it("skips cookies with no value", () => {
    expect(serializeCookie({ empty: { value: null } })).toBeUndefined();
  });
});

describe("createLazyBody", () => {
  const jsonReq = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://x/", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });

  it("parses JSON lazily and converts between kinds", async () => {
    const body = createLazyBody(jsonReq('{"a":1}'));
    expect(await body.json()).toEqual({ a: 1 });
    expect(await body.text()).toBe('{"a":1}');
  });

  it("rejects malformed JSON with BodyParseError", async () => {
    const body = createLazyBody(jsonReq("{oops"));
    await expect(body.json()).rejects.toBeInstanceOf(BodyParseError);
    await expect(body.json()).rejects.toMatchObject({ status: 400 });
  });

  it("enforces content-length limits", async () => {
    const body = createLazyBody(
      jsonReq('{"a":1}', { "content-length": "7", "content-type": "application/json" }),
      { maxJsonBytes: 5 },
    );
    await expect(body.json()).rejects.toMatchObject({ status: 413 });
  });

  it("enforces size limits on chunked bodies (no content-length)", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"veryLongKey":1234567890}'));
        controller.close();
      },
    });
    const req = new Request("http://x/", {
      method: "POST",
      // @ts-expect-error duplex is required for stream bodies
      body: stream,
      duplex: "half",
      headers: { "content-type": "application/json" },
    } as RequestInit);
    const body = createLazyBody(req, { maxJsonBytes: 10 });
    await expect(body.json()).rejects.toMatchObject({ status: 413 });
  });

  it("tracks consumed state", async () => {
    const body = createLazyBody(jsonReq('{"a":1}'));
    expect(body.consumed).toBe(false);
    await body.json();
    expect(body.consumed).toBe(true);
  });

  it("returns null stream once consumed", async () => {
    const body = createLazyBody(jsonReq('{"a":1}'));
    expect(body.stream()).not.toBeNull();
    await body.json();
    expect(body.stream()).toBeNull();
  });

  it("reads raw bytes via arrayBuffer", async () => {
    const body = createLazyBody(jsonReq('{"a":1}'));
    const buf = await body.arrayBuffer();
    expect(new TextDecoder().decode(buf)).toBe('{"a":1}');
  });
});

describe("sendFile", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ignex-http-"));
    file = join(dir, "hello.txt");
    writeFileSync(file, "hello world");

    // The node test environment has no Bun global; provide a Bun.file stand-in
    // so sendFile's Blob-based slicing is exercised end-to-end.
    vi.stubGlobal("Bun", {
      file: (p: string) => new File([readFileSync(p)], basename(p)),
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a file with caching headers", async () => {
    const res = await sendFile(file);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toContain("W/");
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(await res.text()).toBe("hello world");
  });

  it("returns 304 for a matching If-None-Match", async () => {
    const first = await sendFile(file);
    const etag = first.headers.get("etag");
    const req = new Request("http://x/", { headers: { "if-none-match": etag as string } });
    const res = await sendFile(file, { req });
    expect(res.status).toBe(304);
  });

  it("serves byte ranges with 206", async () => {
    const req = new Request("http://x/", { headers: { range: "bytes=0-4" } });
    const res = await sendFile(file, { req });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(await res.text()).toBe("hello");
  });

  it("serves suffix ranges", async () => {
    const req = new Request("http://x/", { headers: { range: "bytes=-5" } });
    const res = await sendFile(file, { req });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("world");
  });

  it("returns 416 for unsatisfiable ranges", async () => {
    const req = new Request("http://x/", { headers: { range: "bytes=100-200" } });
    const res = await sendFile(file, { req });
    expect(res.status).toBe(416);
  });

  it("adds content-disposition when downloading", async () => {
    const res = await sendFile(file, { download: true });
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("hello.txt");
  });

  it("throws NotFoundError for a missing file", async () => {
    await expect(sendFile(join(dir, "nope.txt"))).rejects.toBeInstanceOf(NotFoundError);
  });
});
