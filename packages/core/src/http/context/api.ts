/**
 * @fileoverview Ignex Context — the public factory.
 *
 * Creates the per-request {@link IgnexContext} from a `Request`, matched route
 * params and pre-computed {@link ContextOptions}. Used by `createApp`
 * (interpreted) and the compiler-generated server.
 */

import { IgnexContextImpl } from "./impl";
import type { ContextOptions, IgnexContext } from "./types";

/**
 * Create a per-request context.
 *
 * `params` are the matched route params; `opts` supplies the pre-parsed query,
 * body instance/options, route pattern, cache and proxy-trust settings. Used
 * by `createApp` (interpreted) and the compiler-generated server.
 */
export function createContext<P = Record<string, string>>(
  req: Request,
  params: P,
  opts: ContextOptions = {},
): IgnexContext<P, URLSearchParams> {
  return new IgnexContextImpl(req, params, opts);
}
