/**
 * @fileoverview Lifecycle domain types — hook containers, lifecycle stores and
 * decoration shapes. Re-exported through `./index` (the unified type umbrella).
 */

export type LifeCycleType = "global" | "scoped" | "local";

export interface HookContainer<T = (...args: any[]) => any> {
  fn: T;
  scope?: LifeCycleType;
  subType?: string;
  checksum?: number;
  isAsync?: boolean;
  hasReturn?: boolean;
}

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

export interface DocumentDecoration {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: Record<string, string[]>[];
  [key: string]: unknown;
}
