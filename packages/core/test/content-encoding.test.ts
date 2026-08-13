/**
 * Content-Encoding tests: pure negotiation/compressibility/ETag helpers and
 * the compression plugin's negotiation + variant-ETag behavior through
 * `createApp`, plus a property invariant over generated Accept-Encoding
 * headers.
 */

import { arbQsValue } from "@ignex/test-utils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  etagWithEncoding,
  isCompressible,
  negotiateEncoding,
} from "../src/data/content-encoding.js";
import { compression, createApp } from "../src/index.js";

const req = (url: string, init: RequestInit = {}) => new Request(`http://x${url}`, init);

describe("negotiateEncoding", () => {
  const supported = ["br", "gzip", "deflate"];

  it("picks the highest-weight acceptable encoding", () => {
    expect(negotiateEncoding("br;q=0.8, gzip;q=0.9", supported)).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.5, br;q=0.9, deflate;q=0.2", supported)).toBe("br");
  });

  it("ties are broken by server (supported) preference", () => {
    expect(negotiateEncoding("gzip, br", supported)).toBe("br");
  });

  it("excludes q=0 encodings", () => {
    expect(negotiateEncoding("gzip;q=0, deflate", supported)).toBe("deflate");
    expect(negotiateEncoding("br;q=0, gzip;q=0, deflate;q=0", supported)).toBeNull();
  });

  it("applies a wildcard * to unlisted supported encodings", () => {
    expect(negotiateEncoding("*", supported)).toBe("br");
    expect(negotiateEncoding("deflate;q=0, *", supported)).toBe("br");
  });

  it("an explicit q=0 beats a wildcard", () => {
    expect(negotiateEncoding("br;q=0, *;q=1", supported)).toBe("gzip");
  });

  it("returns null for empty/identity/unacceptable headers", () => {
    expect(negotiateEncoding("", supported)).toBeNull();
    expect(negotiateEncoding("identity", supported)).toBeNull();
    expect(negotiateEncoding("foo;q=1", supported)).toBeNull();
  });

  it("defaults missing q to 1", () => {
    expect(negotiateEncoding("deflate", ["gzip"])).toBeNull();
    expect(negotiateEncoding("deflate", ["gzip", "deflate"])).toBe("deflate");
  });
});

describe("isCompressible", () => {
  it("compresses text-like content types", () => {
    expect(isCompressible("text/plain")).toBe(true);
    expect(isCompressible("text/html; charset=utf-8")).toBe(true);
    expect(isCompressible("application/json")).toBe(true);
    expect(isCompressible("application/javascript")).toBe(true);
    expect(isCompressible("image/svg+xml")).toBe(true);
  });

  it("skips binary/media content types", () => {
    expect(isCompressible("image/png")).toBe(false);
    expect(isCompressible("application/octet-stream")).toBe(false);
    expect(isCompressible("video/mp4")).toBe(false);
  });
});

describe("etagWithEncoding", () => {
  it("suffixes strong and weak ETags inside the quotes", () => {
    expect(etagWithEncoding('"abc"', "gzip")).toBe('"abc-gzip"');
    expect(etagWithEncoding('W/"abc"', "br")).toBe('W/"abc-br"');
  });
});

describe("compression plugin negotiation", () => {
  it("honors client preference between br and gzip", async () => {
    const payload = JSON.stringify({ data: "x".repeat(2000) });
    const app = createApp({
      plugins: [compression()],
      handler: () => new Response(payload, { headers: { "content-type": "application/json" } }),
    });
    const res = await app.handler(
      req("/", { headers: { "accept-encoding": "br;q=0.5, gzip;q=1" } }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const gz = await res.arrayBuffer();
    const text = await new Response(
      new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(text).toBe(payload);
  });

  it("suffixes the ETag for the compressed variant", async () => {
    const payload = JSON.stringify({ data: "x".repeat(2000) });
    const app = createApp({
      plugins: [compression()],
      handler: () =>
        new Response(payload, {
          headers: { "content-type": "application/json", etag: '"abc"' },
        }),
    });
    const res = await app.handler(req("/", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("etag")).toBe('"abc-gzip"');
  });

  it("deflate round-trips via CompressionStream", async () => {
    const payload = "x".repeat(5000);
    const app = createApp({
      plugins: [compression()],
      handler: () => new Response(payload, { headers: { "content-type": "text/plain" } }),
    });
    const res = await app.handler(req("/", { headers: { "accept-encoding": "deflate" } }));
    expect(res.headers.get("content-encoding")).toBe("deflate");
    const raw = await res.arrayBuffer();
    const text = await new Response(
      new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).text();
    expect(text).toBe(payload);
  });

  it("does not compress when the client excludes every supported encoding", async () => {
    const app = createApp({
      plugins: [compression()],
      handler: () =>
        new Response(JSON.stringify({ x: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const res = await app.handler(
      req("/", { headers: { "accept-encoding": "gzip;q=0, br;q=0, deflate;q=0" } }),
    );
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

describe("negotiateEncoding property", () => {
  it("never returns an explicitly excluded encoding", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            encoding: fc.constantFrom("br", "gzip", "deflate", "*", "identity"),
            q: arbQsValue,
          }),
          { maxLength: 6, selector: (p) => p.encoding },
        ),
        (prefs) => {
          const header = prefs.map((p) => `${p.encoding};q=${p.q}`).join(", ");
          const supported = ["br", "gzip", "deflate"];
          const result = negotiateEncoding(header, supported);

          if (result !== null) {
            expect(supported).toContain(result);
            for (const p of prefs) {
              if (p.encoding === result) {
                expect(p.q).toBeGreaterThan(0);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
