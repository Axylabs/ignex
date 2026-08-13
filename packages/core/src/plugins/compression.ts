/**
 * @fileoverview Compression plugin — Bun 1.4 edition.
 *
 * Adds Brotli when available. When the Rust addon is loaded, gzip is done in
 * Rust (buffered) for maximum throughput; the streaming `CompressionStream`
 * path remains the fallback (deflate, brotli, or native unavailable).
 */

import { gzipCompress, isNativeAvailable } from "@ignus/native";
import { etagWithEncoding, isCompressible, negotiateEncoding } from "../data/content-encoding";
import type { IgnusContext } from "../http/context";
import { appendVary } from "../http/headers";
import type { IgnusPlugin } from "../lifecycle/plugin";

/** Options for {@link compression}. */
export interface CompressionOptions {
  threshold?: number;
  filter?: (contentType: string) => boolean;
  /** Use the Rust gzip path for buffered bodies (default `true`). */
  native?: boolean;
}

let supportsBrotli = false;

try {
  const CS = (globalThis as any).CompressionStream;

  if (typeof CS !== "undefined") {
    new CS("br");
    supportsBrotli = true;
  }
} catch {
  supportsBrotli = false;
}

/**
 * Response compression plugin (Brotli when available, gzip via Rust when the
 * addon is loaded, `CompressionStream` fallback otherwise).
 *
 * @param options - Size threshold, content-type filter, native toggle.
 * @returns The compression plugin.
 */
export const compression = (options: CompressionOptions = {}): IgnusPlugin => {
  const { threshold = 1024, filter = isCompressible, native = true } = options;

  const serveUncompressed = (
    body: Uint8Array<ArrayBuffer>,
    response: Response,
    headers: Headers,
  ): Response => {
    headers.delete("content-encoding");
    headers.set("content-length", String(body.byteLength));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const serveCompressed = (body: BodyInit, response: Response, headers: Headers): Response =>
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });

  return {
    name: "compression",

    async onResponse(ctx, response) {
      const supported = supportsBrotli ? ["br", "gzip", "deflate"] : ["gzip", "deflate"];
      const plan = await buildPlan(ctx, response, threshold, filter, supported);
      if (!plan) return response;

      if (plan.body.byteLength < threshold) {
        return serveUncompressed(plan.body, plan.response, plan.headers);
      }

      // Rust gzip fast path (buffered). The body is already read once; if
      // compression fails we serve the same bytes uncompressed.
      if (native && plan.encoding === "gzip" && isNativeAvailable()) {
        return compressNativeGzip(plan, serveUncompressed);
      }

      const CS = (globalThis as any).CompressionStream;
      if (typeof CS === "undefined") {
        return response;
      }

      // Streaming compression over the already-buffered bytes.
      const bodyStream = new Response(plan.body as unknown as BodyInit).body;
      if (!bodyStream) {
        return response;
      }
      const compressed = bodyStream.pipeThrough(new CS(plan.encoding));
      return serveCompressed(compressed, plan.response, plan.headers);
    },
  };
};

interface CompressPlan {
  response: Response;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
  encoding: string;
}

/**
 * Decide whether a response should be compressed and, if so, negotiate the
 * encoding and buffer the body once. Returns `null` when compression does not
 * apply (no body, already encoded, filtered content type, under threshold,
 * no acceptable encoding, or unreadable body).
 */
async function buildPlan(
  ctx: IgnusContext,
  response: Response,
  threshold: number,
  filter: (contentType: string) => boolean,
  supported: string[],
): Promise<CompressPlan | null> {
  if (!response.body) return null;
  if (response.headers.get("content-encoding")) return null;

  const contentType = response.headers.get("content-type") || "";
  if (!filter(contentType)) return null;

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength && contentLength < threshold) return null;

  const encoding = negotiateEncoding(ctx.headers.get("accept-encoding") || "", supported);
  if (!encoding) return null;

  const headers = new Headers(response.headers);
  headers.set("content-encoding", encoding);
  headers.delete("content-length");
  appendVary(headers, "Accept-Encoding");

  // A compressed body is a distinct representation: suffix the ETag so
  // caches keep compressed/uncompressed variants separate (RFC 7232).
  const etag = headers.get("etag");
  if (etag) headers.set("etag", etagWithEncoding(etag, encoding));

  // Buffer the body ONCE so the REAL size is known and tiny responses are
  // skipped — compressing a 36-byte body is pure waste (the re-wrap +
  // gzip path dominates the response cost). This also lets us emit an
  // accurate content-length (Bun does not set one automatically).
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }

  return { response, headers, body, encoding };
}

/** Rust gzip fast path; serves the bytes uncompressed if compression fails. */
function compressNativeGzip(
  plan: CompressPlan,
  serveUncompressed: (
    body: Uint8Array<ArrayBuffer>,
    response: Response,
    headers: Headers,
  ) => Response,
): Response {
  const { body, response, headers } = plan;
  try {
    const compressed = gzipCompress(body) as unknown as BodyInit;
    if (compressed instanceof Uint8Array) {
      headers.set("content-length", String(compressed.byteLength));
    }
    return new Response(compressed, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return serveUncompressed(body, response, headers);
  }
}
