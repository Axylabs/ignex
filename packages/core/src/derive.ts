/**
 * @fileoverview Derive & Resolve — Context enrichment pipeline.
 * Composable, type-safe context extensions.
 */

import type { FluxContext } from "./context";
import type { MaybePromise } from "./types";

export type DeriveFn<
  In extends Record<string, unknown> = {},
  Out extends Record<string, unknown> = {},
> = (ctx: FluxContext & In) => MaybePromise<Out>;

export type ResolveFn<
  In extends Record<string, unknown> = {},
  Out extends Record<string, unknown> = {},
> = (ctx: FluxContext & In) => MaybePromise<Out>;

// ============================================================================
// Pipeline core (shared by derive + resolve)
// ============================================================================

/** Shared pipeline implementation; both public factories type the fn list. */
const createPipeline = <
  Fn extends (ctx: FluxContext) => MaybePromise<Record<string, unknown>>,
>() => {
  const fns: Fn[] = [];

  return {
    add(fn: Fn) {
      fns.push(fn);
      return this;
    },

    async execute(ctx: FluxContext): Promise<FluxContext> {
      const current = ctx;
      for (const fn of fns) {
        const result = await fn(current);
        if (result && typeof result === "object") {
          Object.assign(current, result);
        }
      }
      return current;
    },

    get length() {
      return fns.length;
    },
  };
};

/** Derive pipeline — runs before validation. */
export const createDerivePipeline = () => createPipeline<DeriveFn>();

/** Resolve pipeline — runs after validation, before the handler. */
export const createResolvePipeline = () => createPipeline<ResolveFn>();

// ============================================================================
// Common Derive Factories
// ============================================================================

export const deriveUser =
  <T>(extractor: (ctx: FluxContext) => MaybePromise<T | null>) =>
  async (ctx: FluxContext) => ({ user: await extractor(ctx) });

export const deriveDb =
  <T>(factory: () => T) =>
  (_ctx: FluxContext) => ({ db: factory() });
