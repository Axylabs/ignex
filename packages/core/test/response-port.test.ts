/**
 * @fileoverview Port of Elysia `test/response/*` — streaming responses,
 * generator teardown on cancel/abort, and response ownership on the
 * interpreted `createApp().handler()` path.
 *
 * `sendFile`/HTTP Range/conditional and SSE framing already have dedicated
 * suites (`http.test.ts`, `http-stream.test.ts`); this file covers the
 * remaining response-surface scenarios: `ctx.stream` generator semantics,
 * mid-stream cancellation teardown, response header/body ownership, and
 * content-type inference for the text/html/json builders.
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

const dec = new TextDecoder();
const decodeChunk = (v: unknown): string => (v instanceof Uint8Array ? dec.decode(v) : String(v));

const readAll = async (body: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!body) return "";
  const reader = body.getReader();
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decodeChunk(value);
  }
  return acc;
};

/** Read a stream up to `count` chunks, then cancel (simulating client drop). */
const readNThenCancel = async (
  body: ReadableStream<Uint8Array> | null,
  count: number,
): Promise<string[]> => {
  if (!body) return [];
  const reader = body.getReader();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(decodeChunk(value));
  }
  await reader.cancel();
  return out;
};

const toStream = (gen: AsyncGenerator<string>): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(enc.encode(value));
    },
    async cancel() {
      await gen.return?.();
    },
  });
};

describe("streaming responses", () => {
  it("streams generator chunks in order; content-type is caller-supplied", async () => {
    const res = await inject(
      app((ctx) =>
        ctx.stream(
          toStream(
            (async function* () {
              yield "a";
              yield "b";
              yield "c";
            })(),
          ),
        ),
      ),
      { url: "/" },
    );

    expect(res.status).toBe(200);
    // `ctx.stream` sets no default content-type — the caller supplies headers.
    expect(res.headers.get("content-type")).toBeNull();
    await expect(readAll(res.body)).resolves.toBe("abc");
  });

  it("honours caller-supplied headers on ctx.stream", async () => {
    const res = await inject(
      app((ctx) =>
        ctx.stream(toStream((async function* () {})()), {
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
      { url: "/" },
    );

    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("streams with delays while preserving order", async () => {
    const seen: string[] = [];
    const res = await inject(
      app((ctx) =>
        ctx.stream(
          toStream(
            (async function* () {
              yield "a";
              await new Promise((r) => setTimeout(r, 5));
              yield "b";
              await new Promise((r) => setTimeout(r, 5));
              yield "c";
            })(),
          ),
        ),
      ),
      { url: "/" },
    );

    const reader = res.body?.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(decodeChunk(value));
    }
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("tears the generator down (return) when the client cancels mid-stream", async () => {
    let returned = false;
    const gen = (async function* () {
      try {
        yield "a";
        yield "b";
        yield "c";
      } finally {
        returned = true;
      }
    })();

    const res = await inject(
      app((ctx) =>
        ctx.stream(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await gen.next();
              if (done) controller.close();
              else controller.enqueue(new TextEncoder().encode(value));
            },
            cancel() {
              void gen.return?.();
            },
          }),
        ),
      ),
      { url: "/" },
    );

    const chunks = await readNThenCancel(res.body, 2);
    expect(chunks).toEqual(["a", "b"]);
    // Cancellation propagates through to the generator's finally.
    await new Promise((r) => setTimeout(r, 10));
    expect(returned).toBe(true);
  });
});

describe("response ownership", () => {
  it("ctx.json sets application/json content-type and content-length", async () => {
    const res = await inject(
      app((ctx) => ctx.json({ a: 1 })),
      { url: "/" },
    );

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-length")).toBe(String(JSON.stringify({ a: 1 }).length));
    await expect(res.json()).resolves.toEqual({ a: 1 });
  });

  it("ctx.text and ctx.html set the correct content types", async () => {
    const text = await inject(
      app((ctx) => ctx.text("hi")),
      { url: "/" },
    );
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(text.text()).resolves.toBe("hi");

    const html = await inject(
      app((ctx) => ctx.html("<p>hi</p>")),
      { url: "/" },
    );
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(html.text()).resolves.toBe("<p>hi</p>");
  });

  it("passes a custom Response through untouched (handler returns Response directly)", async () => {
    const custom = new Response("raw", { status: 206, headers: { "x-custom": "yes" } });
    const res = await inject(
      app(() => custom),
      { url: "/" },
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("x-custom")).toBe("yes");
    await expect(res.text()).resolves.toBe("raw");
  });

  it("still applies ctx.set headers to a streamed response", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.headers["x-mid"] = "set";
        return ctx.stream(toStream((async function* () {})()));
      }),
      { url: "/" },
    );

    expect(res.headers.get("x-mid")).toBe("set");
  });
});

describe("empty / no-content responses", () => {
  it("ctx.empty() yields 204 with no body", async () => {
    const res = await inject(
      app((ctx) => ctx.empty()),
      { url: "/" },
    );

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});
