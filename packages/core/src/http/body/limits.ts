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

/** Resolve the effective limits, filling every option with its default. */
export const resolveLimits = (opts: LazyBodyOptions = {}): ResolvedLimits => ({
  maxJsonBytes: opts.maxJsonBytes ?? DEFAULT_LIMITS.maxJsonBytes,
  maxTextBytes: opts.maxTextBytes ?? DEFAULT_LIMITS.maxTextBytes,
  maxFormBytes: opts.maxFormBytes ?? DEFAULT_LIMITS.maxFormBytes,
  maxFileBytes: opts.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
});
