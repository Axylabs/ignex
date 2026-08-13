/**
 * @fileoverview Lifecycle domain types — hook containers, lifecycle stores and
 * decoration shapes. Re-exported through `./index` (the unified type umbrella).
 */

/** The scope a hook applies to: global (all requests) or scoped/local. */
export type LifeCycleType = "global" | "scoped" | "local";

/**
 * A single lifecycle hook with runtime metadata (checksum for de-dup, flags
 * for the compiler's usage analysis). `T` is the hook function type.
 */
export interface HookContainer<T = (...args: any[]) => any> {
  fn: T;
  scope?: LifeCycleType;
  subType?: string;
  checksum?: number;
  isAsync?: boolean;
  hasReturn?: boolean;
}

/** A named collection of {@link HookContainer}s, one per lifecycle stage. */
export interface LifeCycleStore {
  start: HookContainer[];
  request: HookContainer[];
  parse: HookContainer[];
  transform: HookContainer[];
  beforeHandle: HookContainer[];
  afterHandle: HookContainer[];
  mapResponse: HookContainer[];
  afterResponse: HookContainer[];
  trace: HookContainer[];
  error: HookContainer[];
  stop: HookContainer[];
}

/** An empty {@link LifeCycleStore} with every stage as an empty array. */
export const EMPTY_LIFECYCLE: LifeCycleStore = {
  start: [],
  request: [],
  parse: [],
  transform: [],
  beforeHandle: [],
  afterHandle: [],
  mapResponse: [],
  afterResponse: [],
  trace: [],
  error: [],
  stop: [],
};

/** OpenAPI operation decoration (summary/description/tags/security/…). */
export interface DocumentDecoration {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: Record<string, string[]>[];
  [key: string]: unknown;
}
