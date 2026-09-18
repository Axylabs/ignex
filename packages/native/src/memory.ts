/**
 * @fileoverview Process-level memory maintenance — the `@ignex/native` bridge
 * to castrum's maintenance hooks.
 *
 * Long-lived servers accumulate process-level state after config/schema churn:
 * castrum's global loader LRU, its process-wide MIME caches, and the native
 * compiled-schema dedupe store. castrum 0.9.9 exposes the escape hatches —
 * the TS-layer `flushMemory({ gc? })` and the napi `rust.clearSchemaCache()` —
 * and this module routes to them WITHOUT importing castrum directly (the
 * ignex rule: castrum is reachable only through `@ignex/native`).
 *
 * Both functions are lazy and NEVER throw: when the module (or a given hook) is
 * absent they resolve as a no-op, so `IGNEX_NATIVE=off` parity holds and an
 * explicit maintenance call can never crash a healthy process. A genuine
 * failure (loader rejects, the hook itself throws) is reported through
 * {@link reportDegradation} instead of being swallowed silently.
 *
 * @remarks The loader is consulted per call rather than cached: maintenance is
 * a rare, explicit operation, and `loadCastrumModule`'s underlying dynamic
 * `import()` is already cached by the runtime, so only the cheap package
 * resolution repeats.
 */
import { loadCastrumModule } from "./loader";
import { reportDegradation } from "./telemetry";

/** Options for {@link flushNativeMemory}. */
export interface FlushNativeMemoryOptions {
  /**
   * Also request a full runtime GC. castrum defaults this to `true`; pass
   * `false` to drop caches only (e.g. when the host manages GC itself).
   */
  readonly gc?: boolean;
}

/**
 * Minimal structural view of the castrum module surface this bridge uses.
 * `flushMemory` is the TS-layer export; `clearSchemaCache` lives on the
 * `rust` object (with a defensive top-level alias accepted too).
 */
interface CastrumMemoryModule {
  flushMemory?: (options?: FlushNativeMemoryOptions) => void;
  rust?: { clearSchemaCache?: () => void };
  clearSchemaCache?: () => void;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Drop process-level native caches and optionally request a GC.
 *
 * Delegates to castrum's TS `flushMemory({ gc? })` when the module is
 * loadable; otherwise it is a silent no-op. Never throws.
 *
 * @param options - Forwarded to castrum. Omit for its default (`gc: true`).
 * @returns A promise that resolves once the flush has been requested.
 * @example
 * ```ts
 * import { flushNativeMemory } from "@ignex/native";
 *
 * await flushNativeMemory({ gc: false }); // drop caches, skip the GC request
 * ```
 */
export const flushNativeMemory = async (options?: FlushNativeMemoryOptions): Promise<void> => {
  try {
    const mod = (await loadCastrumModule()) as CastrumMemoryModule | null;
    const flush = mod?.flushMemory;
    if (typeof flush !== "function") {
      // A missing module is the documented fallback; a present module that
      // lacks the hook means the installed castrum predates it — surface that.
      if (mod) {
        reportDegradation(
          "surface-missing",
          "memory.flush",
          "castrum.flushMemory is not exported by the loaded module",
        );
      }
      return;
    }
    flush.call(mod, options);
  } catch (error) {
    reportDegradation("call-failed", "memory.flush", describeError(error));
  }
};

/**
 * Drop the native compiled-schema cache (castrum's `rust.clearSchemaCache`).
 *
 * Prefers the `rust.*` method and accepts a top-level export as a fallback.
 * A silent no-op when neither is available; never throws. Already-constructed
 * ingress/route instances keep their own compiled schema, so live routes are
 * unaffected.
 *
 * @returns A promise that resolves once the cache drop has been requested.
 * @example
 * ```ts
 * import { clearNativeSchemaCache } from "@ignex/native";
 *
 * await clearNativeSchemaCache(); // e.g. after a schema/config reload
 * ```
 */
export const clearNativeSchemaCache = async (): Promise<void> => {
  try {
    const mod = (await loadCastrumModule()) as CastrumMemoryModule | null;
    const rust = mod?.rust;
    const clear = rust?.clearSchemaCache ?? mod?.clearSchemaCache;
    if (typeof clear !== "function") {
      if (mod) {
        reportDegradation(
          "surface-missing",
          "memory.schema-cache",
          "castrum exposes no clearSchemaCache hook",
        );
      }
      return;
    }
    clear.call(rust ?? mod);
  } catch (error) {
    reportDegradation("call-failed", "memory.schema-cache", describeError(error));
  }
};
