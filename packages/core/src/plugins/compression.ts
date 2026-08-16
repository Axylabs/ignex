/**
 * @fileoverview Compression plugin — Bun 1.4 edition.
 *
 * Adds Brotli when available. When the Rust addon is loaded, gzip is done in
 * Rust (buffered) for maximum throughput; the streaming `CompressionStream`
 * path remains the fallback (deflate, brotli, or native unavailable).
 */

import { gzipCompress, isNativeAvailable } from "@ignex/native";
import { etagWithEncoding, isCompressible, negotiateEncoding } from "../data/content-encoding";
import type { IgnexContext } from "../http/context";
import { appendVary } from "../http/headers";
import type { IgnexPlugin } from "../lifecycle/plugin";

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
export const compression = (options: CompressionOptions = {}): IgnexPlugin => {
  const { threshold = 1024, filter = isCompressible, native = true } = options;

  return {
    name: "compression",

    onResponse(ctx, response) {
      const supported = supportsBrotli ? ["br", "gzip", "deflate"] : ["gzip", "deflate"];
      // Sync fast path: decide whether compression applies WITHOUT buffering
      // the body. The common case (no accept-encoding, tiny body, filtered
      // type, already encoded) returns `null` synchronously — no Promise, no
      // microtask — so this hook is a plain sync return (runHooks only awaits
      // actual Promises).
      const encoding = planEncoding(ctx, response, threshold, filter, supported);
      if (!encoding) return response;
      return compressResponse(response, encoding, threshold, native);
    },
  };
};

interface CompressPlan {
  response: Response;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
  encoding: string;
}

/** Sync: negotiate the encoding and decide whether compression applies. */
function planEncoding(
  ctx: IgnexContext,
  response: Response,
  threshold: number,
  filter: (contentType: string) => boolean,
  supported: string[],
): string | null {
  if (!response.body) return null;
  if (response.headers.get("content-encoding")) return null;

  const contentType = response.headers.get("content-type") || "";
  if (!filter(contentType)) return null;

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength && contentLength < threshold) return null;

  return negotiateEncoding(ctx.headers.get("accept-encoding") || "", supported);
}

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

/**
 * Async compression path (only reached when compression actually applies):
 * build the headers, buffer the body once for the REAL size (tiny responses
 * are skipped), then gzip via Rust / CompressionStream.
 */
async function compressResponse(
  response: Response,
  encoding: string,
  threshold: number,
  native: boolean,
): Promise<Response> {
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
    return response;
  }

  if (body.byteLength < threshold) {
    return serveUncompressed(body, response, headers);
  }

  // Rust gzip fast path (buffered). If compression fails we serve the same
  // bytes uncompressed.
  if (native && encoding === "gzip" && isNativeAvailable()) {
    return compressNativeGzip({ response, headers, body, encoding }, serveUncompressed);
  }

  const CS = (globalThis as any).CompressionStream;
  if (typeof CS === "undefined") {
    return response;
  }

  // Streaming compression over the already-buffered bytes.
  const bodyStream = new Response(body as unknown as BodyInit).body;
  if (!bodyStream) {
    return response;
  }
  const compressed = bodyStream.pipeThrough(new CS(encoding));
  return serveCompressed(compressed, response, headers);
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
