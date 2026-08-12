/**
 * @fileoverview Compression plugin — Bun 1.4 edition.
 *
 * Adds Brotli when available. When the Rust addon is loaded, gzip is done in
 * Rust (buffered) for maximum throughput; the streaming `CompressionStream`
 * path remains the fallback (deflate, brotli, or native unavailable).
 */

import { gzipCompress, isNativeAvailable } from "@ignus/native";
import { etagWithEncoding, isCompressible, negotiateEncoding } from "../data/content-encoding";
import { appendVary } from "../http/headers";
import type { IgnusPlugin } from "../lifecycle/plugin";

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

export const compression = (options: CompressionOptions = {}): IgnusPlugin => {
  const { threshold = 1024, filter = isCompressible, native = true } = options;

  return {
    name: "compression",

    async onResponse(ctx, response) {
      if (!response.body) return response;
      if (response.headers.get("content-encoding")) return response;

      const contentType = response.headers.get("content-type") || "";
      if (!filter(contentType)) return response;

      const contentLength = Number(response.headers.get("content-length") || "0");
      if (contentLength && contentLength < threshold) return response;

      const supported = supportsBrotli ? ["br", "gzip", "deflate"] : ["gzip", "deflate"];
      const encoding = negotiateEncoding(ctx.headers.get("accept-encoding") || "", supported);
      if (!encoding) return response;

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
        // Not worth compressing — serve the identical bytes uncompressed.
        headers.delete("content-encoding");
        headers.set("content-length", String(body.byteLength));
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // Rust gzip fast path (buffered). The body is already read once; if
      // compression fails we serve the same bytes uncompressed.
      if (native && encoding === "gzip" && isNativeAvailable()) {
        try {
          const compressed = gzipCompress(body) as unknown as BodyInit;
          headers.set(
            "content-length",
            String(compressed instanceof Uint8Array ? compressed.byteLength : 0),
          );
          return new Response(compressed, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch {
          headers.delete("content-encoding");
          headers.set("content-length", String(body.byteLength));
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
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

      return new Response(compressed, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
