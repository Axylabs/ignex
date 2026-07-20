/**
 * @fileoverview Derive & Resolve — Context enrichment pipeline.
 * Composable, type-safe context extensions.
 */

import type { FluxContext } from "./context";
import type { MaybePromise } from "./types";

export type DeriveFn<In extends Record<string, unknown> = {}, Out extends Record<string, unknown> = {}> =
  (ctx: FluxContext & In) => MaybePromise<Out>;

export type ResolveFn<In extends Record<string, unknown> = {}, Out extends Record<string, unknown> = {}> =
  (ctx: FluxContext & In) => MaybePromise<Out>;

// ============================================================================
// Derive Pipeline (runs before validation)
// ============================================================================

export const createDerivePipeline = () => {
  const fns: DeriveFn[] = [];

  return {
    add(fn: DeriveFn) { fns.push(fn); return this; },

    async execute(ctx: FluxContext): Promise<FluxContext> {
      let current = ctx;
      for (const fn of fns) {
        const result = await fn(current);
        if (result && typeof result === "object") {
          Object.assign(current, result);
        }
      }
      return current;
    },

    get length() { return fns.length; },
  };
};

// ============================================================================
// Resolve Pipeline (runs after validation, before handler)
// ============================================================================

export const createResolvePipeline = () => {
  const fns: ResolveFn[] = [];

  return {
    add(fn: ResolveFn) { fns.push(fn); return this; },

    async execute(ctx: FluxContext): Promise<FluxContext> {
      let current = ctx;
      for (const fn of fns) {
        const result = await fn(current);
        if (result && typeof result === "object") {
          Object.assign(current, result);
        }
      }
      return current;
    },

    get length() { return fns.length; },
  };
};

// ============================================================================
// Common Derive Factories
// ============================================================================

export const deriveUser = <T>(extractor: (ctx: FluxContext) => MaybePromise<T | null>) =>
  async (ctx: FluxContext) => ({ user: await extractor(ctx) });

export const deriveDb = <T>(factory: () => T) =>
  (ctx: FluxContext) => ({ db: factory() });

export const deriveRequestId = () =>
  (ctx: FluxContext) => ({ requestId: ctx.requestId });