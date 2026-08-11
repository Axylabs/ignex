/**
 * @fileoverview Conditional-request helpers (ETag / If-Modified-Since).
 *
 * Single source of truth for the `if-none-match` split/trim/includes check and
 * the `if-modified-since` date comparison — previously inlined in
 * `data/cache.ts` (browser cache + response cache) and `http/files.ts`.
 */

/** `true` when the request's preconditions match the given entity tags/dates. */
export const isNotModified = (req: Request, etag?: string, lastModified?: string): boolean => {
  const inm = req.headers.get("if-none-match");

  if (
    etag &&
    inm &&
    inm
      .split(",")
      .map((s) => s.trim())
      .includes(etag)
  ) {
    return true;
  }

  const ims = req.headers.get("if-modified-since");

  if (lastModified && ims && new Date(ims).getTime() >= new Date(lastModified).getTime()) {
    return true;
  }

  return false;
};
