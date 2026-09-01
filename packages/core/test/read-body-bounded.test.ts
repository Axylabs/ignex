/**
 * readBodyBounded — the streaming body cap used by the compiled native
 * prelude: content-length pre-check (no read when over) + incremental chunked
 * enforcement (the hole an unconditional `req.arrayBuffer()` leaves open).
 */
import { describe, expect, it } from "vitest";
import { BodyParseError } from "../src/http/body";
import { readBodyBounded } from "../src/http/body/size";

const reqWith = (body: BodyInit | null, headers: Record<string, string> = {}): Request =>
  new Request("http://localhost/x", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);

const chunked = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array);
      else controller.close();
    },
  });
};

describe("readBodyBounded", () => {
  it("returns the full body under the cap", async () => {
    const payload = new TextEncoder().encode('{"ok":true}');
    const req = reqWith(new Blob([payload as unknown as BodyInit]), {
      "content-length": String(payload.length),
    });
    const out = await readBodyBounded(req, 1024);
    expect(Buffer.from(out).toString()).toBe('{"ok":true}');
  });

  it("413s on content-length over the cap WITHOUT reading", async () => {
    const req = reqWith(new Blob([new Uint8Array(16)]), { "content-length": "999999" });
    await expect(readBodyBounded(req, 1024)).rejects.toThrow(BodyParseError);
    try {
      const req2 = reqWith(new Blob([new Uint8Array(16)]), { "content-length": "999999" });
      await readBodyBounded(req2, 1024);
    } catch (err) {
      expect((err as BodyParseError).status).toBe(413);
    }
  });

  it("413s mid-stream when a CHUNKED body exceeds the cap (no content-length)", async () => {
    // 3 chunks of 600B against a 1024B cap — the second chunk crosses it.
    const chunks = [new Uint8Array(600).fill(0x61), new Uint8Array(600).fill(0x62)];
    const req = reqWith(chunked(chunks));
    const err = await readBodyBounded(req, 1024).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BodyParseError);
    expect((err as BodyParseError).status).toBe(413);
  });

  it("accepts a chunked body exactly at the cap", async () => {
    const a = new Uint8Array(600).fill(0x61);
    const b = new Uint8Array(424).fill(0x62); // 600+424 === 1024 === cap
    const out = await readBodyBounded(reqWith(chunked([a, b])), 1024);
    expect(out.byteLength).toBe(1024);
    expect(out[0]).toBe(0x61);
    expect(out[1023]).toBe(0x62);
  });

  it("returns empty for a bodyless request", async () => {
    const req = new Request("http://localhost/x", { method: "GET" });
    const out = await readBodyBounded(req, 1024);
    expect(out.byteLength).toBe(0);
  });

  it("reads unbounded when no cap is given", async () => {
    const payload = new Uint8Array(4096).fill(0x7f);
    const out = await readBodyBounded(reqWith(new Blob([payload])));
    expect(out.byteLength).toBe(4096);
  });
});
