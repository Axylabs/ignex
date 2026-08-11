/**
 * @fileoverview Guard — Scoped hook application.
 * Apply hooks to a group of routes with proper scoping.
 */

import type { HookContainer, LifeCycleStore, LifeCycleType } from "../types";
import { mergeHookArrays } from "./hooks";

export interface GuardOptions {
  scope?: LifeCycleType;
  beforeHandle?: HookContainer | HookContainer[];
  afterHandle?: HookContainer | HookContainer[];
  transform?: HookContainer | HookContainer[];
  error?: HookContainer | HookContainer[];
  onRequest?: HookContainer | HookContainer[];
}

export const createGuard = (options: GuardOptions = {}) => {
  const scope = options.scope ?? "scoped";

  const toContainers = (hooks: HookContainer | HookContainer[] | undefined): HookContainer[] => {
    if (!hooks) return [];
    const arr = Array.isArray(hooks) ? hooks : [hooks];
    return arr.map((h) =>
      // A bare function is a valid hook (same dialect as `lifecycle`); do NOT
      // spread it (spreading a function yields `{}` and drops the hook).
      typeof h === "function" ? { fn: h, scope } : { ...h, scope: h.scope ?? scope },
    );
  };

  const guardHooks: Partial<LifeCycleStore> = {
    beforeHandle: toContainers(options.beforeHandle),
    afterHandle: toContainers(options.afterHandle),
    transform: toContainers(options.transform),
    error: toContainers(options.error),
    request: toContainers(options.onRequest),
  };

  return {
    scope,
    hooks: guardHooks,

    applyTo(lifecycle: LifeCycleStore): LifeCycleStore {
      return {
        ...lifecycle,
        beforeHandle: mergeHookArrays(lifecycle.beforeHandle, guardHooks.beforeHandle),
        afterHandle: mergeHookArrays(lifecycle.afterHandle, guardHooks.afterHandle),
        transform: mergeHookArrays(lifecycle.transform, guardHooks.transform),
        error: mergeHookArrays(lifecycle.error, guardHooks.error),
        request: mergeHookArrays(lifecycle.request, guardHooks.request),
      };
    },
  };
};

export const mergeLifeCycle = (a: LifeCycleStore, b: Partial<LifeCycleStore>): LifeCycleStore => ({
  start: mergeHookArrays(a.start, b.start),
  request: mergeHookArrays(a.request, b.request),
  parse: mergeHookArrays(a.parse, b.parse),
  transform: mergeHookArrays(a.transform, b.transform),
  beforeHandle: mergeHookArrays(a.beforeHandle, b.beforeHandle),
  afterHandle: mergeHookArrays(a.afterHandle, b.afterHandle),
  mapResponse: mergeHookArrays(a.mapResponse, b.mapResponse),
  afterResponse: mergeHookArrays(a.afterResponse, b.afterResponse),
  trace: mergeHookArrays(a.trace, b.trace),
  error: mergeHookArrays(a.error, b.error),
  stop: mergeHookArrays(a.stop, b.stop),
});
