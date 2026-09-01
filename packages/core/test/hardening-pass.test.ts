/**
 * Hardening pass regressions (2026-08 enterprise audit fixes):
 *  - session id rotation API (fixation defense) — stateless + store-backed
 *  - secret strength guard is env-independent (unset NODE_ENV = strict)
 *  - chunked bodies are bounded mid-stream on the interpreted path (no
 *    buffer-then-check memory amplification)
 *  - sendFile/streamDownload set `x-content-type-options: nosniff`
 *  - safeJoin rejects symlink escapes from the root
 *  - forwardRequest strips client-supplied forwarded-* headers
 *  - SSE backpressure pauses the generator (and tears down a dead consumer)
 *  - deliberate serve() defaults (body cap + WS frame ceiling)
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BodyParseError } from "../src/http/body/errors";
import { createLazyBody } from "../src/http/body/lazy-body";
import type { IgnexContext } from "../src/http/context";
import { createContext } from "../src/http/context";
import { safeJoin, sendFile, streamDownload } from "../src/http/files";
import { forwardRequest } from "../src/http/proxy";
import { sse } from "../src/http/sse";
import {
  createApp,
  createMemorySessionStore,
  createSessionManager,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  DEFAULT_WS_MAX_PAYLOAD_LENGTH,
  getSession,
  session as sessionPlugin,
  signCookie,
} from "../src/index";

// The node test environment has no Bun global; provide a Bun.file stand-in so
// sendFile is exercised end-to-end (same pattern as static-app.test.ts).
beforeAll(() => {
  vi.stubGlobal("Bun", {
    file: (p: string) => new File([readFileSync(p)], basename(p)),
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// ── helpers ─────────────────────────────────────────────────────────────

const STRONG = "a-strong-session-secret-123456";

let savedNodeEnv: string | undefined;
const withNodeEnv = <T>(env: string | undefined, fn: () => T): T => {
  savedNodeEnv = process.env.NODE_ENV;
  if (env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;
  try {
    return fn();
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }
};

const ctxFor = (req: Request): IgnexContext => createContext(req, {}, {});

const postReq = (body: BodyInit | null, headers: Record<string, string> = {}): Request =>
  new Request("http://localhost/x", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── session rotation ────────────────────────────────────────────────────

/** Pull the raw cookie VALUE out of a `set-cookie` header (`sid=xxx; …`). */
const extractValue = (rawSetCookie: string): string => {
  const match = /sid=([^;]+)/.exec(rawSetCookie);
  return (match as RegExpMatchArray)[1] as string;
};

describe("session rotate (fixation defense)", () => {
  it("rotates the id, preserves data, rewrites the cookie (stateless)", async () => {
    const app = createApp({
      plugins: [sessionPlugin({ secret: STRONG, createIfMissing: true })],
      handler: async (ctx) => {
        const s = await getSession(ctx);
        if (!s) return new Response("no session", { status: 500 });
        const oldId = s.id;
        s.data.user = "u1";
        await s.save();
        await s.rotate();
        return Response.json({ oldId, newId: s.id });
      },
      exposeErrors: true,
    });

    const res = await app.handler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const { oldId, newId } = (await res.json()) as { oldId: string; newId: string };
    expect(newId).not.toBe(oldId);

    // The response carries the ROTATED cookie under the new id (cookie values
    // are URL-encoded envelopes — decode before inspecting).
    const setCookie = res.headers.get("set-cookie") ?? "";
    const decoded = decodeURIComponent(extractValue(setCookie));
    expect(decoded).toContain(`"id":"${newId}"`);
    expect(decoded).not.toContain(`"id":"${oldId}"`);

    // Round-trip: the rotated cookie resolves to the same session WITH data.
    const mgr = createSessionManager({ secret: STRONG });
    const ctx2 = ctxFor(postReq(null, { cookie: `sid=${extractValue(setCookie)}` }));
    const loaded = await mgr.load(ctx2);
    expect(loaded?.id).toBe(newId);
    expect(loaded?.data.user).toBe("u1");
  });

  it("kills the old id on replay (store-backed): row deleted, cookie cleared", async () => {
    const store = createMemorySessionStore({ ttlSeconds: 60 });
    const mgr = createSessionManager({ secret: STRONG, store });
    const ctx = ctxFor(postReq(null));
    const session = await mgr.loadOrCreate(ctx);
    await session.save();

    // Capture the CURRENT signed cookie by round-tripping through a load:
    // persist() wrote it into ctx's response headers — rebuild it via the
    // manager's own seal (signCookie over the envelope) is internal, so use
    // the public flow instead: rotate, then replay the PRE-rotation cookie.
    const preRotateEnvelope = JSON.stringify({
      id: session.id,
      data: session.data,
      exp: Math.floor(session.expiresAt / 1000),
    });
    const preRotateCookie = signCookie(preRotateEnvelope, STRONG);

    const oldId = session.id;
    await session.rotate();

    expect(await store.get(oldId)).toBeNull();
    expect(await store.get(session.id)).not.toBeNull();

    // Replaying the pre-rotation cookie: envelope decodes but the store row
    // is gone → treated as missing and cleared.
    const ctxReplay = ctxFor(postReq(null, { cookie: `sid=${preRotateCookie}` }));
    const replayed = await mgr.load(ctxReplay);
    expect(replayed).toBeNull();
    store.close?.();
  });
});

// ── secret strength guard — env independence ────────────────────────────

describe("secret strength guard (env-independent)", () => {
  it("rejects weak secrets when NODE_ENV is UNSET (staging shape)", () => {
    expect(() => withNodeEnv(undefined, () => createSessionManager({ secret: "short" }))).toThrow(
      /16 characters/,
    );
  });

  it("rejects known dev defaults outside explicit local development", () => {
    expect(() =>
      withNodeEnv(undefined, () => createSessionManager({ secret: "dev-secret-change-me" })),
    ).toThrow(/dev default/);
    expect(() =>
      withNodeEnv("production", () => createSessionManager({ secret: "dev-secret-change-me" })),
    ).toThrow(/dev default/);
  });

  it("stays lenient in explicit local development", () => {
    expect(() =>
      withNodeEnv("development", () => createSessionManager({ secret: "super-secret" })),
    ).not.toThrow();
    expect(() =>
      withNodeEnv("test", () => createSessionManager({ secret: "s3cret" })),
    ).not.toThrow();
  });

  it("IGNEX_ALLOW_WEAK_SECRET=1 bypasses with a loud warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.IGNEX_ALLOW_WEAK_SECRET = "1";
      expect(() =>
        withNodeEnv(undefined, () => createSessionManager({ secret: "short" })),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("weak session secret"));
    } finally {
      delete process.env.IGNEX_ALLOW_WEAK_SECRET;
      warn.mockRestore();
    }
  });
});

// ── chunked body bounds on the interpreted path ─────────────────────────

describe("lazy-body chunked enforcement", () => {
  const streamOf = (parts: Uint8Array[]): ReadableStream<Uint8Array> => {
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < parts.length) controller.enqueue(parts[i++] as Uint8Array);
        else controller.close();
      },
    });
  };

  it("413s a chunked JSON body mid-stream (no content-length)", async () => {
    const req = postReq(streamOf([new Uint8Array(700).fill(0x7b), new Uint8Array(700).fill(0x7d)]));
    const body = createLazyBody(req, { maxJsonBytes: 1024 });
    const err = await body.json().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BodyParseError);
    expect((err as BodyParseError).status).toBe(413);
  });

  it("413s a chunked text body over the cap", async () => {
    const req = postReq(streamOf([new Uint8Array(2048).fill(0x61)]));
    const body = createLazyBody(req, { maxTextBytes: 1024 });
    await expect(body.text()).rejects.toThrow(BodyParseError);
  });

  it("parses an in-cap chunked JSON body normally", async () => {
    const payload = new TextEncoder().encode('{"ok":true}');
    const req = postReq(streamOf([payload]));
    const body = createLazyBody(req, { maxJsonBytes: 1024 });
    await expect(body.json()).resolves.toEqual({ ok: true });
  });

  it("bounds chunked urlencoded form bodies", async () => {
    const req = postReq(
      streamOf([new Uint8Array(2048).fill(0x61)]),
      // No content-type → default selection; force urlencoded explicitly:
      { "content-type": "application/x-www-form-urlencoded" },
    );
    const body = createLazyBody(req, { maxFormBytes: 1024 });
    const err = await body.form().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BodyParseError);
    expect((err as BodyParseError).status).toBe(413);
  });
});

// ── file responses: nosniff + symlink-hardened safeJoin ────────────────

describe("file response hardening", () => {
  it("sendFile sets x-content-type-options: nosniff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-files-"));
    cleanupDirs.push(dir);
    const file = join(dir, "upload.txt");
    writeFileSync(file, "hello");
    const res = await sendFile(file);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("streamDownload sets x-content-type-options: nosniff", () => {
    const res = streamDownload(new ReadableStream<Uint8Array>(), { filename: "a.bin" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("safeJoin rejects a symlink pointing outside the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-symlink-"));
    cleanupDirs.push(dir);
    const root = join(dir, "public");
    mkdirSync(root);
    writeFileSync(join(dir, "secret.txt"), "top secret");
    symlinkSync(join(dir, "secret.txt"), join(root, "leak.txt"));

    const err = (() => {
      try {
        safeJoin(root, "leak.txt");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).not.toBeNull(); // ForbiddenError — the escape is refused

    // A normal in-root file still resolves.
    writeFileSync(join(root, "ok.txt"), "fine");
    expect(realpathSync(safeJoin(root, "ok.txt"))).toBe(realpathSync(join(root, "ok.txt")));
  });
});

// ── proxy: strip untrusted forwarded headers ────────────────────────────

describe("forwardRequest forwarded-header hygiene", () => {
  it("strips client-supplied x-forwarded-for/host/proto by default", async () => {
    let seen: Headers | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.headers as Headers;
      return new Response("ok");
    }) as typeof fetch;
    try {
      const req = new Request("http://edge.internal/x?q=1", {
        headers: { "x-forwarded-for": "9.9.9.9", "x-forwarded-proto": "https" },
      });
      await forwardRequest(req, "http://upstream.internal/");
      expect(seen?.get("x-forwarded-for")).toBeNull();
      expect(seen?.get("x-forwarded-proto")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves them only on explicit opt-in", async () => {
    let seen: Headers | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.headers as Headers;
      return new Response("ok");
    }) as typeof fetch;
    try {
      const req = new Request("http://edge.internal/x", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      await forwardRequest(req, "http://upstream.internal/", { preserveForwardedHeaders: true });
      expect(seen?.get("x-forwarded-for")).toBe("10.0.0.1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── SSE backpressure ────────────────────────────────────────────────────

describe("sse backpressure", () => {
  it("pauses the generator while the consumer lags, resumes after reads", async () => {
    let produced = 0;
    const gen = async function* (): AsyncGenerator<string> {
      for (;;) {
        produced++;
        yield `e${produced}`;
        await new Promise((r) => setTimeout(r, 1));
      }
    };
    const res = sse(gen());
    const reader = (res.body as ReadableStream<unknown>).getReader();

    // Read one frame; the producer may run slightly ahead but must NOT run
    // away unbounded while we are not reading.
    await reader.read();
    const afterFirst = produced;
    await new Promise((r) => setTimeout(r, 30));
    // Backpressure pause keeps runaway production within a small bound.
    expect(produced - afterFirst).toBeLessThan(50);
    await reader.cancel();
  });

  it("tears the generator down under sustained backlog (dead consumer)", async () => {
    let done = false;
    const gen = async function* (): AsyncGenerator<string> {
      try {
        for (let i = 0; ; i++) yield `e${i}`;
      } finally {
        done = true;
      }
    };
    const res = sse(gen());
    const reader = (res.body as ReadableStream<unknown>).getReader();
    await reader.read(); // first frame delivered; then never read again
    // Sustained backlog (>1000 queued frames ≈ >1s of 1ms waits) → teardown.
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 8000, interval: 50 });
    await reader.cancel().catch(() => {});
  });
});

// ── deliberate serve() defaults ─────────────────────────────────────────

describe("serve defaults", () => {
  it("exposes deliberate ceilings (documented constants, not Bun inheritence)", () => {
    expect(DEFAULT_MAX_REQUEST_BODY_SIZE).toBeLessThan(128 * 1024 * 1024);
    expect(DEFAULT_MAX_REQUEST_BODY_SIZE).toBeGreaterThan(20 * 1024 * 1024); // > upload default
    expect(DEFAULT_WS_MAX_PAYLOAD_LENGTH).toBe(4 * 1024 * 1024);
  });
});
