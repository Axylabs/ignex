/**
 * Route-manager bridge — embed castrum's native ingress pre-flight pipeline
 * (CORS, rate-limit, IP-trust, body-guard, JSON-schema) as an opt-in request
 * stage. This is the "route manager" integration point: an app or plugin can
 * run the Rust 8-stage pipeline BEFORE its own handlers, and short-circuit
 * with the pipeline's terminal response when it decides to (e.g. CORS
 * preflight, 429, 413, 400/422).
 *
 * Returns `null` (never throws) when the addon or its pipeline layer is not
 * available, so importing this module is always safe and the pipeline is a
 * pure acceleration layer. The native outcome is normalized into the small
 * {@link NativePreflightOutcome} shape below so consumers don't depend on
 * castrum's internal types.
 */

import { loadCastrumModule } from "./loader";

export interface NativePreflightResult {
  readonly ok: boolean;
  readonly status: number;
  readonly terminal: boolean;
  readonly rateLimited: boolean;
  readonly requestId: string;
  readonly body: Uint8Array;
}

export interface NativePreflightOutcome {
  /** True when the pipeline short-circuited — serve `response`. */
  readonly terminal: boolean;
  readonly response: Response | null;
  readonly result: NativePreflightResult | null;
}

export interface NativePipeline {
  /**
   * Run the native pre-flight pipeline for a request. On any native failure
   * (or when the pipeline is unavailable) this resolves to a non-terminal
   * outcome so the request flow is never broken by the addon.
   */
  preprocess(request: Request, ip?: string): Promise<NativePreflightOutcome>;
}

/** Minimal structural view of castrum's `createPipeline`/`IngressPipeline`. */
interface CastrumPipelineModule {
  createPipeline?: (options?: unknown) => unknown;
}

interface CastrumOutcome {
  terminal?: boolean;
  response?: Response | null;
  result?: {
    ok?: boolean;
    status?: number;
    rateLimited?: boolean;
    requestId?: string;
    body?: Uint8Array;
  };
}

let modulePromise: Promise<CastrumPipelineModule | null> | null = null;

const loadPipelineModule = async (): Promise<CastrumPipelineModule | null> => {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    try {
      // `loadCastrumModule` resolves the real castrum entry by absolute path,
      // bypassing the tsconfig `paths` stub that a bare `import("castrum")`
      // would hit at runtime.
      const mod = (await loadCastrumModule()) as CastrumPipelineModule;
      return typeof mod.createPipeline === "function" ? mod : null;
    } catch {
      return null;
    }
  })();
  return modulePromise;
};

/**
 * Create a native pre-flight pipeline, or `null` when unavailable.
 *
 * `options` is passed through to castrum's `createPipeline` (ingress options
 * such as `cors`, `rateLimit`, `schema`, `limits`, plus runtime hooks). The
 * module import and pipeline construction are cached across calls.
 */
export const createNativePipeline = async (options?: unknown): Promise<NativePipeline | null> => {
  const mod = await loadPipelineModule();
  if (!mod) return null;

  let instance: { preprocess?: (request: Request, ip?: string) => unknown } | null = null;
  try {
    // castrum's `createPipeline` expects the ingress option bag NESTED under
    // `{ options }` (CreatePipelineOptions). Passing it flat would silently
    // disable rate-limit/CORS/schema/limits — the pipeline would run with no
    // configured stages. Wrap it so the plugin's `options` reach the addon.
    const pipeline = mod.createPipeline?.({ options });
    instance =
      pipeline && typeof (pipeline as { preprocess?: unknown }).preprocess === "function"
        ? (pipeline as { preprocess: (request: Request, ip?: string) => unknown })
        : null;
  } catch {
    instance = null;
  }
  if (!instance) return null;

  return {
    async preprocess(request, ip) {
      try {
        const out = (await instance!.preprocess!(request, ip)) as CastrumOutcome;
        const terminal = out.terminal === true;
        const result = out.result
          ? {
              ok: out.result.ok === true,
              status: out.result.status ?? 0,
              terminal,
              rateLimited: out.result.rateLimited === true,
              requestId: out.result.requestId ?? "",
              body: out.result.body ?? new Uint8Array(0),
            }
          : null;
        return { terminal, response: out.response ?? null, result };
      } catch {
        // Defensive: a native failure must never break the request flow.
        return { terminal: false, response: null, result: null };
      }
    },
  };
};
