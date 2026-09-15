/**
 * @fileoverview Declared context requirements of the framework's own plugins.
 *
 * A plugin registered in an app config is an OPAQUE runtime object: the
 * compiler cannot see which `ctx` members its hooks read, so it must assume
 * "any of them" and keep every route on the full-context path
 * (`hasGlobalLifecycle` → `needsFull`). This module is the escape hatch — a
 * declaration, per internal plugin, of exactly which members its hooks touch,
 * so codegen can reason about them statically.
 *
 * A declaration here is a CORRECTNESS claim, not a hint. A member that is
 * omitted but actually read hands the hook `undefined`. Every entry is
 * therefore audited against the plugin's own hook bodies, and a plugin that
 * cannot be expressed — because the specialized context does not emit the
 * member it reads — must stay `null`.
 */

import { type ContextUsage, EMPTY_USAGE } from "@ignex/shared";
import type { PluginCallInfo } from "../../types";

/** Modules the framework's own plugins are published from. */
const INTERNAL_PLUGIN_SOURCES: ReadonlySet<string> = new Set(["@ignex/core", "@ignex/core/index"]);

/** A `ContextUsage` with every field writable, for accumulation. */
type MutableUsage = { -readonly [K in keyof ContextUsage]: boolean };

/**
 * Audited context usage per internal plugin, keyed by EXPORT name.
 *
 * `null` means "not declared": the plugin's requirements are unknown to the
 * compiler, so it must keep forcing the full context. That is the safe default
 * and the only correct answer for anything not explicitly audited below.
 */
export const INTERNAL_PLUGIN_USAGE: Readonly<Record<string, Readonly<ContextUsage> | null>> =
  Object.freeze({
    /**
     * `security()` — `isHttpsRequest` reads `ctx.headers.get("x-forwarded-proto")`
     * when `trustProxy` is set, and otherwise falls back to `ctx.req.url`; its
     * `onResponse` body works on the `Response` (a WeakSet probe and header
     * writes) and reads no further context members. BOTH of those members are
     * emitted by the specialized context (`headers: req.headers`, `req`), so the
     * declaration is expressible.
     */
    security: Object.freeze({ ...EMPTY_USAGE, headers: true, req: true }),

    /**
     * `cors()` reads `ctx.headers.get("origin")`,
     * `ctx.headers.get("access-control-request-headers")` and — for the OPTIONS
     * preflight branch — `ctx.method`.
     *
     * This was UNDECLARABLE until `method` gained its own `ContextUsage` flag
     * and the specialized context began emitting `method: req.method`. It used
     * to collapse onto the `url` flag, so codegen emitted `url` and nothing
     * emitted `method` — declaring `cors` narrow would have handed the hook
     * `undefined` and silently broken preflight. Both members are now
     * expressible, so the declaration is sound.
     */
    cors: Object.freeze({ ...EMPTY_USAGE, headers: true, method: true }),
  });

/** The merged context requirement of an app's whole plugin layer. */
export interface GlobalPluginUsage {
  /**
   * Every member the registered plugins' hooks may read, or `null` when the
   * requirement is UNKNOWN — in which case the caller must keep forcing the
   * full context.
   */
  readonly usage: Readonly<ContextUsage> | null;
}

/**
 * Merge the declared context usage of every plugin registered in an app config.
 *
 * Yields `usage: null` — i.e. "treat the plugin layer as opaque" — whenever the
 * requirement cannot be fully established, which is any of: the plugin list did
 * not fully resolve; a plugin did not come from the framework's own package (a
 * user plugin); or an internal plugin carries no declaration. Only a fully
 * attributed AND fully declared list produces a usable requirement.
 *
 * @param calls - Resolved plugin calls from {@link analyzePluginCalls}.
 * @param allResolved - That analysis's conservative gate.
 * @returns The merged requirement, or `null` usage when unknown.
 */
export const resolveGlobalPluginUsage = (
  calls: readonly PluginCallInfo[],
  allResolved: boolean,
): GlobalPluginUsage => {
  if (!allResolved) return { usage: null };

  const merged: MutableUsage = { ...EMPTY_USAGE };
  for (const call of calls) {
    if (!INTERNAL_PLUGIN_SOURCES.has(call.source)) return { usage: null };
    const declared = INTERNAL_PLUGIN_USAGE[call.name];
    if (!declared) return { usage: null };
    for (const key of Object.keys(declared) as (keyof ContextUsage)[]) {
      if (declared[key]) merged[key] = true;
    }
  }

  return { usage: Object.freeze(merged) };
};
