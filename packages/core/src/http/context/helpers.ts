/**
 * @fileoverview Ignex Context — pure helpers (headers, socket IP, pathname).
 *
 * Small, side-effect-free utilities shared by the context implementation and
 * the compiled server: the null-prototype header accumulator, the response
 * `set` consumption pass, the memoized `requestIP` probe, cheap pathname
 * extraction and `ctx.ip` resolution.
 */

import { lastForwardedIp } from "../../platform/coerce";
import type { SetHeaders } from "../headers";
import type { IgnexServer } from "./types";

/**
 * A fresh header accumulator with a NULL prototype.
 *
 * Null-prototype is deliberate and load-bearing: header names come from app
 * code (`ctx.set.headers[name] = value`), so a plain `{}` would let a name like
 * `constructor` or `__proto__` resolve through `Object.prototype`.
 *
 * `Object.create(null)` is used rather than the `{ __proto__: null }` object
 * literal because the literal is measurably SLOWER for this access pattern —
 * creation cost is identical (~3.5ns) but keyed writes are roughly 2x:
 *
 *   Object.create(null) + 4 keyed writes   17.8 ns/req
 *   { __proto__: null } + 4 keyed writes   33.5 ns/req
 *
 * A null-prototype literal takes shape transitions on every new key, while
 * `Object.create(null)` is a dictionary object where a keyed write is a direct
 * hash insert. (This was tried the other way round and reverted — the earlier
 * "win" was run-to-run noise; see docs/perf-methodology.md "Resolution
 * limit".)
 */
export const emptyHeaders = (): Record<string, string> =>
  Object.create(null) as Record<string, string>;

/**
 * Result of the one-time `requestIP` capability probe.
 *
 * `0` = not yet probed, `1` = usable, `2` = unusable (it threw).
 */
let requestIpState: 0 | 1 | 2 = 0;

/**
 * Retire the scalar entries of `set.headers` once a reply has baked them in.
 *
 * `ctx.json`/`text`/`html` build the response with the accumulated
 * `set.headers` already in the header record, so re-applying them in the
 * `applySet` pass would cost a native `Headers.get` per header plus the whole
 * `mutateHeaders` wrapper — the single most expensive per-request path the
 * framework had. Blanking the accumulator makes `applySet` take its
 * zero-allocation early return instead.
 *
 * Array-valued headers are carried over: they need `append` semantics, which
 * only `applySet` can express. Headers written AFTER the reply is built (by
 * `afterHandle`/`mapResponse` hooks) land in the fresh accumulator and are
 * applied normally — so ordering semantics are unchanged.
 *
 * @param set - The request's response accumulator.
 */
export const consumeSetHeaders = (set: SetHeaders): void => {
  const headers = set.headers;
  let carry: Record<string, string> | undefined;

  for (const k in headers) {
    if (!Object.hasOwn(headers, k)) continue;
    const v = (headers as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      carry ??= emptyHeaders();
      carry[k] = v as unknown as string;
    }
  }

  set.headers = carry ?? emptyHeaders();
};

/**
 * Read the peer address via the runtime's `requestIP`, with the `try/catch`
 * paid only on the FIRST call.
 *
 * `requestIP` is non-standard: on some runtimes the method exists but throws
 * rather than returning `undefined`. Wrapping every call in `try/catch` kept
 * the per-request cost ~2x a bare call (measured on the comparison bench:
 * ~1.8us/req vs the equivalent unwrapped call). Probing once and then calling
 * bare preserves the failure handling while letting the hot path optimize.
 *
 * @param server - The server handle (may be `undefined` off-Bun).
 * @param req - The request whose peer address is wanted.
 * @returns The address, or `undefined` when unavailable.
 */
export const readSocketIp = (
  server: IgnexServer | null | undefined,
  req: Request,
): string | undefined => {
  if (requestIpState === 2) return undefined;

  if (requestIpState === 1) {
    const ip = server?.requestIP?.(req)?.address;
    return ip === undefined || ip === "" ? undefined : ip;
  }

  try {
    const ip = server?.requestIP?.(req)?.address;
    requestIpState = 1;
    return ip === undefined || ip === "" ? undefined : ip;
  } catch (err) {
    requestIpState = 2;
    // Surface it at info level instead of silently masking the failure, then
    // fall through to the proxy-header / "anonymous" paths forever.
    console.info("[ignex] requestIP unavailable:", err);
    return undefined;
  }
};

/**
 * Cheap pathname extraction from an absolute request URL without allocating a
 * full `URL` object. Equivalent to `new URL(url).pathname` for the absolute
 * URLs Bun's `Request.url` carries (e.g. `http://host:3000/api/users?x=1`):
 * the path is the percent-encoded substring after the authority, cut at the
 * first `?` or `#` (never decoded), with a bare authority mapping to `/`.
 */
export const pathnameOf = (url: string): string => {
  const schemeEnd = url.indexOf("://");
  const start =
    schemeEnd === -1
      ? url.startsWith("//")
        ? url.indexOf("/", 2)
        : 0
      : url.indexOf("/", schemeEnd + 3);
  if (start === -1) return "/";

  let end = url.length;
  const query = url.indexOf("?", start);
  const fragment = url.indexOf("#", start);
  if (query !== -1 && query < end) end = query;
  if (fragment !== -1 && fragment < end) end = fragment;

  const path = url.slice(start, end);
  return path === "" ? "/" : path;
};

/**
 * Resolve a request's client address exactly the way `ctx.ip` does.
 *
 * Exported so the compiler's usage-specialized context can emit `ip` instead
 * of forcing a route that reads it onto the full context. An address resolved
 * one way in a compiled build and another in an interpreted one would diverge
 * silently — and `ip` is what rate limiting, allow-lists and access logs key
 * on. One implementation, so there is nothing to drift.
 *
 * When `trustProxy` is set the forwarded headers carry the CLIENT's address
 * and must win. Resolving the socket address FIRST made `trustProxy` a no-op:
 * `server.requestIP()` succeeds on essentially every request and returns the
 * PROXY's address, so the header branch was unreachable and every IP-keyed
 * feature silently saw the proxy instead of the client. It is also the
 * cheapest order for a proxied deployment: it skips a native peer-address
 * lookup measured at ~3.4us/request in situ.
 *
 * @param server - The serving instance, or `null` before boot.
 * @param req - The request whose client address is wanted.
 * @param trustProxy - Whether forwarded headers are authoritative.
 * @returns The client address, or `"anonymous"` when it cannot be resolved.
 */
export const resolveClientIp = (
  server: IgnexServer | null | undefined,
  req: Request,
  trustProxy: boolean,
): string => {
  if (trustProxy) {
    const forwarded =
      req.headers.get("x-real-ip") ?? lastForwardedIp(req.headers.get("x-forwarded-for"));
    if (forwarded) return forwarded;
  }

  // `readSocketIp` memoizes the "is `requestIP` usable here?" probe, so a
  // server without it does not pay a throwing call per request.
  return readSocketIp(server, req) ?? "anonymous";
};
