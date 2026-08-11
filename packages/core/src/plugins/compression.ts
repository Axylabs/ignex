/**
 * @fileoverview Compression plugin — Bun 1.4 edition.
 *
 * Adds Brotli when available. When the Rust addon is loaded, gzip is done in
 * Rust (buffered) for maximum throughput; the streaming `CompressionStream`
 * path remains the fallback (deflate, brotli, or native unavailable).
 */

import { gzipCompress, isNativeAvailable } from "@flux/native";
import { appendVary } from "../http/headers";
import type { FluxPlugin } from "../lifecycle/plugin";

export interface CompressionOptions {
  threshold?: number;
  filter?: (contentType: string) => boolean;
  /** Use the Rust gzip path for buffered bodies (default `true`). */
  native?: boolean;
}

const COMPRESSIBLE = new Set([
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "image/svg+xml",
]);

const shouldCompress = (ct: string): boolean => {
  for (const prefix of COMPRESSIBLE) {
    if (ct.startsWith(prefix)) return true;
  }

  return false;
};

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

export const compression = (options: CompressionOptions = {}): FluxPlugin => {
  const { threshold = 1024, filter = shouldCompress, native = true } = options;

  return {
    name: "compression",

    async onResponse(ctx, response) {
      if (!response.body) return response;
      if (response.headers.get("content-encoding")) return response;

      const contentType = response.headers.get("content-type") || "";
      if (!filter(contentType)) return response;

      const contentLength = Number(response.headers.get("content-length") || "0");
      if (contentLength && contentLength < threshold) return response;

      const acceptEncoding = ctx.headers.get("accept-encoding") || "";

      const encoding =
        supportsBrotli && acceptEncoding.includes("br")
          ? "br"
          : acceptEncoding.includes("gzip")
            ? "gzip"
            : acceptEncoding.includes("deflate")
              ? "deflate"
              : null;

      if (!encoding) return response;

      const headers = new Headers(response.headers);
      headers.set("content-encoding", encoding);
      headers.delete("content-length");
      appendVary(headers, "Accept-Encoding");

      // Rust gzip fast path (buffered, maximum throughput). The body is read
      // once; if compression fails we serve the same bytes uncompressed.
      if (native && encoding === "gzip" && isNativeAvailable()) {
        let body: Uint8Array;
        try {
          body = new Uint8Array(await response.arrayBuffer());
        } catch {
          return response;
        }
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
          return new Response(body as unknown as BodyInit, {
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

      // NOTE: the body is REPLACED with the compressed stream, so we cannot
      // reuse `reWrapResponse` (which keeps the original body).
      const compressed = response.body.pipeThrough(new CS(encoding));

      return new Response(compressed, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
