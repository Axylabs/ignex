/**
 * @fileoverview The hook engine: contract interpretation, flattening and the
 * timed stage runner.
 *
 * Split out of `./run` (maintainability size cap) so `run.ts` stays focused on
 * the request lifecycle. The compiled server emits `runHooks`/`runTimed` calls
 * from `@ignex/core` — this module IS that runtime, imported (not copied) by
 * codegen.
 */

import { currentTrace, isTracingEnabled } from "../debug/tracer";
import type { SpanKind } from "../debug/types";
import type { IgnexContext } from "../http/context";
import type { HookContainer } from "../types";

/** Outcome of a hook chain: continue with `ctx`, or halt with a `response`. */
export interface RunHooksResult {
  ctx: IgnexContext;
  response?: Response;
}

/** Interpret one hook result: halt with a Response or continue with a ctx. */
const interpretHook = (
  result: unknown,
  ctx: IgnexContext,
): { halted: Response | undefined; next: IgnexContext } => {
  if (result instanceof Response) return { halted: result, next: ctx };
  if (result && typeof result === "object") {
    const res = result as { ok?: boolean; response?: Response; ctx?: IgnexContext };
    if (res.ok === false && res.response instanceof Response)
      return { halted: res.response, next: ctx };
    if (res.response instanceof Response) return { halted: res.response, next: ctx };
    if (res.ctx) return { halted: undefined, next: res.ctx };
  }
  return { halted: undefined, next: ctx };
};

/** Normalize a hook container to its callable fn (or `undefined` when absent/not callable). */
const hookFn = (
  entry: HookContainer | undefined,
): ((ctx: IgnexContext, arg?: unknown) => unknown) | undefined => {
  if (entry == null) return undefined;
  const fn = typeof entry === "function" ? entry : entry.fn;
  return typeof fn === "function" ? fn : undefined;
};

type HookFn = (ctx: IgnexContext, arg?: unknown) => unknown;

/** Memoized flatten of a stage array to its callable hooks (per array identity). */
const flatHookCache = new WeakMap<readonly HookContainer[], readonly HookFn[]>();

/**
 * Pre-resolve a lifecycle stage array's hook containers to their callable
 * functions — ONCE per array. The stage arrays are composed at boot and reused
 * for the life of the app (compiled server module consts, interpreted
 * `buildPreStages`/router bind), so the WeakMap memoization means the hot
 * per-request path iterates PLAIN functions: no per-hook `entry == null` /
 * `typeof` normalization, no per-hook `{ halted, next }` object. Non-callable
 * entries are dropped (matching the previous per-call `hookFn` skip).
 */
const flattenHooks = (hooks: readonly HookContainer[]): readonly HookFn[] => {
  const cached = flatHookCache.get(hooks);
  if (cached) return cached;
  const out: HookFn[] = [];
  for (let i = 0; i < hooks.length; i++) {
    const fn = hookFn(hooks[i]);
    if (fn !== undefined) out.push(fn as HookFn);
  }
  flatHookCache.set(hooks, out);
  return out;
};

/**
 * Run hooks until one halts, WITHOUT forcing an async boundary when every hook
 * is synchronous (the common case: cors/security/ratelimit/logger, native-
 * preflight steady state, sync i18n). Returns the result object synchronously;
 * only when a hook actually returns a Promise is an async continuation used
 * for the remainder. Existing `await` callers keep working; hot-path callers
 * branch on `instanceof Promise` to stay microtask-free (the compiled server
 * emits exactly that).
 *
 * The hook container array is flattened (memoized) on first use, so the hot
 * loop iterates plain functions and interprets results INLINE — zero per-hook
 * intermediate objects on the all-sync path (the common one).
 */
export const runHooks = (
  hooks: readonly HookContainer[] | undefined,
  ctx: IgnexContext,
  arg?: unknown,
): RunHooksResult | Promise<RunHooksResult> => {
  let current = ctx;
  if (!hooks || hooks.length === 0) return { ctx: current };
  const fns = flattenHooks(hooks);
  const len = fns.length;

  // Two specialised loops (rather than an `arg === undefined` test per hook):
  // the hook call site is the single hottest call in the framework, and the
  // extra branch plus the optional-call `?.` both inhibit inlining.
  // `flattenHooks` guarantees every entry is callable, so the call is direct.
  for (let i = 0; i < len; i++) {
    const fn = fns[i] as HookFn;
    const r = arg === undefined ? fn(current) : fn(current, arg);

    if (r instanceof Promise) {
      // An async hook: interpret it, then continue the remainder asynchronously.
      return (async () => {
        const raw = await r;
        const out = interpretHook(raw, current);
        if (out.halted) return { response: out.halted, ctx: current };
        return runHooksAsync(fns, i + 1, out.next, arg);
      })();
    }

    if (r instanceof Response) return { response: r, ctx: current };

    if (r !== null && typeof r === "object") {
      // One `instanceof` instead of the previous two: the same check was
      // evaluated once for the `ok === false` arm and again standalone.
      const res = r as { ok?: boolean; response?: Response; ctx?: IgnexContext };
      const halted = res.response;

      if (halted instanceof Response) return { response: halted, ctx: current };

      if (res.ctx) current = res.ctx;
    }
  }
  return { ctx: current };
};

/** Async continuation used once an async hook is encountered. */
async function runHooksAsync(
  fns: readonly HookFn[],
  start: number,
  ctx: IgnexContext,
  arg?: unknown,
): Promise<RunHooksResult> {
  let current = ctx;
  for (let i = start; i < fns.length; i++) {
    const r = arg === undefined ? fns[i]?.(current) : fns[i]?.(current, arg);
    // Only await actual Promises — a sync hook in the async continuation must
    // not introduce an extra microtask (preserves the original timing/ordering
    // of the interpreted path).
    const raw = r instanceof Promise ? await r : r;
    const out = interpretHook(raw, current);
    if (out.halted) return { response: out.halted, ctx: current };
    current = out.next;
  }
  return { ctx: current };
}

// ============================================================================
// Shared lifecycle pipeline
// ============================================================================

/**
 * True when a debug tracer is installed for this process, so the pipeline can
 * decide between the flat per-request fast path and per-stage instrumentation.
 * A single module-constant read when the debugbar plugin is absent.
 */
export const lifecycleTracing = (): boolean => isTracingEnabled();

/**
 * Run `fn` inside a timed span of `kind` when a trace is active; otherwise
 * just run `fn`. Sync-preserving: when `fn` returns synchronously no Promise
 * is allocated (the span is closed inline), and when it returns a Promise the
 * span stays open until it settles. Failures close the span as failed and are
 * rethrown unchanged.
 */
export const runTimed = <T>(name: string, kind: SpanKind, fn: () => T): T | Promise<T> => {
  const trace = currentTrace();
  if (!trace) return fn();
  const span = trace.start(name, kind);
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        (value) => {
          trace.end(span);
          return value;
        },
        (err: unknown) => {
          trace.fail(span, err);
          throw err;
        },
      );
    }
    trace.end(span);
    return r;
  } catch (err) {
    trace.fail(span, err);
    throw err;
  }
};

/** Re-exported so the compiled server imports one symbol for stage rows. */
