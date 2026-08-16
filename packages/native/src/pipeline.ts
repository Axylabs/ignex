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

/** Normalized result of a native pre-flight pipeline run. */
export interface NativePreflightResult {
  readonly ok: boolean;
  readonly status: number;
  readonly terminal: boolean;
  readonly rateLimited: boolean;
  readonly requestId: string;
  readonly body: Uint8Array;
}

/** Outcome of a pre-flight run: terminal decision plus the pipeline result. */
export interface NativePreflightOutcome {
  /** True when the pipeline short-circuited — serve `response`. */
  readonly terminal: boolean;
  readonly response: Response | null;
  readonly result: NativePreflightResult | null;
}

/** Native ingress pre-flight pipeline (CORS, rate-limit, body-guard, schema). */
export interface NativePipeline {
  /**
   * Run the native pre-flight pipeline for a request. On any native failure
   * (or when the pipeline is unavailable) this resolves to a non-terminal
   * outcome so the request flow is never broken by the addon. Returns the
   * outcome synchronously where possible (the direct C-ABI path) — callers
   * should `await` only when the value is a Promise.
   */
  preprocess(
    request: Request,
    ip?: string,
  ): NativePreflightOutcome | Promise<NativePreflightOutcome>;
  /**
   * True when the pipeline config needs the client IP (rate-limit / trust-proxy
   * enabled). Callers should only resolve `ctx.ip` (a native `requestIP` lookup)
   * when this is true — passing `undefined` otherwise is a free fast path.
   */
  readonly needsIp: boolean;
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

/** Castrum ingress CORS options — allowlist form, distinct from the JS `cors()` plugin. */
export interface NativeCorsOptions {
  /** Allowed origins (`"*"` widens to any origin with no credentials). */
  allowOrigin?: string[];
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  allowCredentials?: boolean;
  maxAge?: number;
}

/** Options for the pipeline's fixed-window rate-limit stage. */
export interface NativeRateLimitOptions {
  limit?: number;
  windowMs?: number;
  maxEntries?: number;
}

/**
 * Ingress options forwarded to castrum's `createIngressHandler`. This is a
 * typed subset of castrum's `IngressFastOptions`; a misspelled/unknown key is
 * rejected at pipeline construction (castrum's fail-fast validation), so keep
 * this surface in sync with castrum's `src/ingress/options.ts`.
 */
export interface NativeIngressOptions {
  trustProxy?: boolean;
  trustedProxies?: { enabled?: boolean; networks?: string[] };
  parseCookies?: boolean;
  parseQuery?: boolean;
  requireJsonBody?: boolean;
  /** Serialized draft-07 schema — validated by the pipeline when a body is read. */
  schema?: Uint8Array;
  cors?: NativeCorsOptions;
  rateLimit?: NativeRateLimitOptions;
  https?: boolean;
  maxBodyBytes?: number;
  enableBodySizeGuard?: boolean;
  emitMetadataJson?: boolean;
  limits?: {
    maxUrlBytes?: number;
    maxQueryBytes?: number;
    maxCookieBytes?: number;
    maxHeadersBytes?: number;
    maxHeaders?: number;
    maxPairs?: number;
  };
}

/** Options for {@link createNativePipeline} (forwarded to castrum's `createPipeline`). */
export interface NativePipelineOptions {
  /** Ingress options (cors/rateLimit/schema/limits) for castrum's createPipeline. */
  options?: NativeIngressOptions;
  /**
   * Runtime hooks for castrum's createPipeline — notably `securityHeaders`
   * (ordered `[name, value][]`) and `enableSecurityHeaders`, which pre-bake the
   * app's security headers into the pipeline's baked terminal/error templates
   * at construction time so error responses (413, 400/422, 429, CORS-forbidden)
   * carry them without a JS lifecycle round-trip.
   */
  runtime?: unknown;
  /**
   * When `true` the pipeline reads the request body (guarded). Default `false`:
   * the framework owns the body, so the pipeline must NOT consume the stream
   * (castrum's createPipeline defaults `readBody` to true).
   */
  readBody?: boolean;
}

/**
 * Create a native pre-flight pipeline, or `null` when unavailable.
 *
 * `options` is passed through to castrum's `createPipeline` (ingress options
 * such as `cors`, `rateLimit`, `schema`, `limits`, plus runtime hooks). The
 * module import and pipeline construction are cached across calls.
 */
export const createNativePipeline = async (
  pipelineOptions: NativePipelineOptions = {},
): Promise<NativePipeline | null> => {
  const mod = await loadPipelineModule();
  if (!mod) return null;

  let instance: { preprocess?: (request: Request, ip?: string) => unknown } | null = null;
  try {
    // castrum's `createPipeline` expects the ingress option bag NESTED under
    // `{ options }` (CreatePipelineOptions); `readBody` is a pipeline-level
    // flag (castrum defaults it to true — force it off so the framework owns
    // the request body and the app can still read it afterwards). Passing the
    // options flat would silently disable rate-limit/CORS/schema/limits.
    // `runtime` carries the pre-baked security headers for terminal responses.
    const pipeline = mod.createPipeline?.({
      options: pipelineOptions.options,
      runtime: pipelineOptions.runtime,
      readBody: pipelineOptions.readBody ?? false,
    });
    instance =
      pipeline && typeof (pipeline as { preprocess?: unknown }).preprocess === "function"
        ? (pipeline as { preprocess: (request: Request, ip?: string) => unknown })
        : null;
  } catch {
    instance = null;
  }
  if (!instance) return null;

  // Narrow the preprocess fn once so the returned closure needs no
  // non-null assertions (captured `instance` is not narrowed by TS inside
  // closures).
  const runPipeline = instance.preprocess;
  if (!runPipeline) return null;

  return {
    // The legacy (castrum TS) path is async — it may read the request body —
    // and it always takes the caller-provided ip through to the pipeline, so
    // `needsIp` is conservatively true (resolving ctx.ip is correct for it).
    needsIp: true,
    async preprocess(request, ip) {
      try {
        const out = (await runPipeline(request, ip)) as CastrumOutcome;
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
