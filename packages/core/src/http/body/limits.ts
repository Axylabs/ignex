/**
 * @fileoverview Body size limits — defaults + option resolution.
 */

import type { LazyBodyOptions } from "./types";

export const DEFAULT_LIMITS = {
  maxJsonBytes: 2 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxFormBytes: 2 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
} as const;

export interface ResolvedLimits {
  maxJsonBytes: number;
  maxTextBytes: number;
  maxFormBytes: number;
  maxFileBytes: number;
}

/**
 * Memoized resolutions, keyed by the caller's options object.
 *
 * Compiled routes pass a FROZEN, route-invariant options object
 * (`__ctxOpts__hN.body`), so the resolved limits are identical for every
 * request on that route — resolving them once per options object instead of
 * once per request removes an object allocation from the body-parsing path.
 */
const limitsCache = new WeakMap<LazyBodyOptions, ResolvedLimits>();

/** Resolve the effective limits, filling every option with its default. */
export const resolveLimits = (opts: LazyBodyOptions = {}): ResolvedLimits => {
  const cached = limitsCache.get(opts);
  if (cached !== undefined) return cached;

  const resolved: ResolvedLimits = {
    maxJsonBytes: opts.maxJsonBytes ?? DEFAULT_LIMITS.maxJsonBytes,
    maxTextBytes: opts.maxTextBytes ?? DEFAULT_LIMITS.maxTextBytes,
    maxFormBytes: opts.maxFormBytes ?? DEFAULT_LIMITS.maxFormBytes,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
  };

  limitsCache.set(opts, resolved);
  return resolved;
};
