/**
 * Compression plugin.
 *
 * Hardened:
 * - guards against missing CompressionStream
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

export const compression = (options: CompressionOptions = {}): FluxPlugin => {
  const { threshold = 1024, filter = shouldCompress } = options;

  return {
    name: "compression",

    onResponse(ctx, response) {
      if (!response.body) return response;
      if (response.headers.get("content-encoding")) return response;

      const ct = response.headers.get("content-type") || "";
      if (!filter(ct)) return response;

      const len = Number(response.headers.get("content-length") || "0");
      if (len && len < threshold) return response;

      const acceptEncoding = ctx.headers.get("accept-encoding") || "";

      const encoding = acceptEncoding.includes("gzip")
        ? "gzip"
        : acceptEncoding.includes("deflate")
          ? "deflate"
          : null;

      if (!encoding) return response;

      if (typeof CompressionStream === "undefined") {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.set("content-encoding", encoding);
      headers.delete("content-length");

      const compressed = response.body.pipeThrough(new CompressionStream(encoding));

      return new Response(compressed, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
