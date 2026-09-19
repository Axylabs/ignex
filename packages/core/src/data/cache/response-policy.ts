/** Shared response eligibility and lifetime decisions for HTTP cache insertion. */
import { parseCacheControl } from "./cache-control";

/** Cache insertion controls; Vary names must also be represented in the key. */
export interface ResponseCachePolicyOptions {
  ttlMs?: number;
  staleTtlMs?: number;
  etag?: boolean;
  vary?: string[];
}

/** Resolve a conservative storage policy; null means serve without storing. */
export const responseCachePolicy = (
  response: Response,
  options: ResponseCachePolicyOptions,
  defaultTtlMs: number,
): { ttlMs: number; staleTtlMs?: number; mustRevalidate: boolean } | null => {
  if (response.headers.has("set-cookie")) return null;
  if (![200, 203, 204, 300, 301, 404, 410].includes(response.status)) return null;
  const directives = parseCacheControl(response.headers.get("cache-control") ?? "");
  if (directives.noStore || directives.noCache || directives.private) return null;
  const configured = new Set((options.vary ?? []).map((name) => name.toLowerCase()));
  const vary = (response.headers.get("vary") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  if (vary.some((name) => name && (name === "*" || !configured.has(name)))) return null;

  const maxAge = directives.sMaxAge ?? directives.maxAge;
  const ttlMs = Math.min(
    options.ttlMs ?? defaultTtlMs,
    maxAge === undefined ? Infinity : maxAge * 1000,
  );
  if (ttlMs <= 0) return null;
  const mustRevalidate =
    directives.mustRevalidate || directives.proxyRevalidate || directives.sMaxAge !== undefined;
  const staleTtlMs = mustRevalidate ? 0 : options.staleTtlMs;
  return { ttlMs, ...(staleTtlMs !== undefined ? { staleTtlMs } : {}), mustRevalidate };
};
