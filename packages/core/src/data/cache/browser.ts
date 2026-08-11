/**
 * @fileoverview Browser-side cache headers + conditional requests.
 */

import { isNotModified } from "../../http/conditional";
import { reWrapResponse } from "../../http/headers";
import { cacheControl } from "./cache-control";
import type { BrowserCacheOptions } from "./types";

/**
 * Apply browser cache headers and handle conditional requests.
 */
export function withBrowserCache(response: Response, opts: BrowserCacheOptions = {}): Response {
  const headers = new Headers(response.headers);

  if (opts.etag) headers.set("etag", opts.etag);

  const lastModified =
    opts.lastModified instanceof Date ? opts.lastModified.toUTCString() : opts.lastModified;

  if (lastModified) headers.set("last-modified", lastModified);

  if (!headers.has("cache-control")) {
    headers.set("cache-control", cacheControl(opts));
  }

  if (opts.vary?.length) {
    headers.set("vary", opts.vary.join(", "));
  }

  if (opts.req && response.status !== 304 && isNotModified(opts.req, opts.etag, lastModified)) {
    return new Response(null, { status: 304, headers });
  }

  return reWrapResponse(response, { headers });
}
