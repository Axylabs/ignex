/**
 * SSE + proxy edge cases — framing, disconnect cancellation, timeout/error
 * handling and hop-by-hop header sanitizing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSSE, proxyRequest, sse } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatSSE", () => {
  it("formats a plain data frame", () => {
    const out = formatSSE({ data: "hello" });
    expect(out).toContain("data: hello");
  });

  it("formats event, id and retry fields", () => {
    const out = formatSSE({ data: "x", event: "update", id: "42", retry: 5000 });
    expect(out).toContain("event: update");
    expect(out).toContain("id: 42");
    expect(out).toContain("retry: 5000");
  });

  it("handles multi-line data", () => {
    const out = formatSSE({ data: "line1\nline2" });
    expect(out).toContain("data: line1");
    expect(out).toContain("data: line2");
  });
});

describe("sse", () => {
  it("streams string and structured chunks", async () => {
    async function* gen() {
      yield "a";
      yield { data: "b", event: "update" };
    }
    const res = sse(gen());
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: a");
    expect(text).toContain("event: update");
    expect(text).toContain("data: b");
  });

  it("stops the generator when the client cancels (disconnect)", async () => {
    let cleanedUp = false;
    async function* gen() {
      try {
        let n = 0;
        while (true) {
          n += 1;
          yield `chunk${n}`;
        }
      } finally {
        cleanedUp = true;
      }
    }

    const res = sse(gen());
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    expect(cleanedUp).toBe(true);
  });

  it("stops the generator on an external abort signal", async () => {
    const controller = new AbortController();
    let cleanedUp = false;
    async function* gen() {
      try {
        while (true) yield "x";
      } finally {
        cleanedUp = true;
      }
    }

    const res = sse(gen(), undefined, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(cleanedUp).toBe(true);
  });

  it("merges user headers into the SSE response", () => {
    async function* gen() {}
    const res = sse(gen(), { headers: { "x-custom": "yes" } });
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});

describe("proxyRequest", () => {
  it("forwards a successful upstream and strips hop-by-hop headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("body", {
            status: 200,
            headers: { connection: "keep-alive", "content-length": "4", "x-custom": "1" },
          }),
      ),
    );

    const res = await proxyRequest("http://upstream/");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-proxy")).toBe("flux");
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.has("connection")).toBe(false);
    expect(res.headers.has("content-length")).toBe(false);
    expect(await res.text()).toBe("body");
  });

  it("returns 502 when the upstream fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect failed");
      }),
    );

    const res = await proxyRequest("http://upstream/");
    expect(res.status).toBe(502);
  });

  it("returns 504 when the request times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init: RequestInit | undefined) => {
        const signal = init?.signal;
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            const err = new Error("timeout");
            err.name = "TimeoutError";
            reject(err);
          });
        });
      }),
    );

    const res = await proxyRequest("http://upstream/", { timeoutMs: 5 });
    expect(res.status).toBe(504);
  });

  it("propagates a caller-provided signal", async () => {
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init: RequestInit | undefined) => {
        seenSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(new Response("ok", { status: 200 }));
      }),
    );

    await proxyRequest("http://upstream/", { signal: controller.signal });
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]?.aborted).toBe(false);
  });
});
