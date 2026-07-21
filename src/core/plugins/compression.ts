/**
 * Compression plugin — Bun 1.4 edition.
 *
 * Adds Brotli when available.
 */

import type { FluxPlugin } from "../plugin";

export interface CompressionOptions {
  threshold?: number;
  filter?: (contentType: string) => boolean;
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
  const { threshold = 1024, filter = shouldCompress } = options;

  return {
    name: "compression",

    onResponse(ctx, response) {
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

      const CS = (globalThis as any).CompressionStream;

      if (typeof CS === "undefined") {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.set("content-encoding", encoding);
      headers.delete("content-length");
      headers.append("vary", "Accept-Encoding");

      const compressed = response.body.pipeThrough(new CS(encoding));

      return new Response(compressed, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
