/**
 * @fileoverview The direct C-ABI ingress pre-flight instance (`createNative
 * Ingress`) — one `castrum_ingress_handle_*` call per request with `cstring`
 * url/ip + the packed headers block, the 48-byte verdict decoded with zero
 * TextDecoder/alloc, and terminal decisions built from the pre-baked security
 * headers + rate-limit/CORS headers. Returns `null` when the addon lacks the
 * ingress symbols.
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */
import { getFfiIngress } from "../ffi";
import { getNative } from "../loader";
import type {
  NativeIngressOptions,
  NativePreflightOutcome,
  NativePreflightResult,
} from "../pipeline";
import { reportDegradation } from "../telemetry";
import { encoder } from "../util";
import {
  DEFAULT_OUTPUT_BUFFER_SIZE,
  EMPTY_BYTES,
  EMPTY_RID,
  MAX_OUTPUT_BUFFER_SIZE,
  METHOD_KIND,
  METHOD_KIND_UNKNOWN,
} from "./constants";
import { buildIngressHeaderPlan, packSelectedHeaders } from "./headers";
import { resolveLayout } from "./layout";
import { buildTerminalResponse } from "./terminal";
import type { IngressVerdict } from "./verdict";
import { decodeVerdict } from "./verdict";

/** Runtime hooks: pre-baked security headers applied to terminal responses. */
export interface NativeIngressRuntime {
  /** Ordered `[name, value][]` security headers baked into terminal responses. */
  securityHeaders?: ReadonlyArray<[string, string]>;
  /** Output buffer size (bytes). Default 131072. */
  outputBufferSize?: number;
  /**
   * Fail-closed mode for native faults (default `false`). When the native
   * pipeline cannot produce a verdict, `false` degrades to pass-through
   * (availability first — historical behavior, now reported via telemetry);
   * `true` rejects the request with 503 so a broken security pipeline can
   * never silently serve unfiltered traffic. Also settable process-wide via
   * `IGNEX_INGRESS_FAIL_CLOSED=1`.
   */
  failClosed?: boolean;
}

/** Resolve the effective fail-closed policy (option wins over the env flag). */
const resolveFailClosed = (failClosed: boolean | undefined): boolean =>
  failClosed ?? process.env.IGNEX_INGRESS_FAIL_CLOSED === "1";

/** The terminal response used when fail-closed and the native core faults. */
const failClosedResponse = (): NativePreflightOutcome => ({
  terminal: true,
  response: new Response(
    encoder.encode(
      JSON.stringify({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "Security pipeline unavailable" },
      }),
    ),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "1" },
    },
  ),
  result: null,
});

/** A direct C-ABI ingress pre-flight instance. */
export interface NativeIngress {
  /**
   * Run the pipeline once for a request. Returns the outcome SYNCHRONOUSLY
   * (the C-ABI core is sync) — no per-request Promise/microtask — typed as
   * `Promise | value` so callers can `await` if they prefer. On any native
   * failure resolves to a non-terminal outcome (never breaks the flow).
   */
  preprocess(
    request: Request,
    ip?: string,
  ): NativePreflightOutcome | Promise<NativePreflightOutcome>;
  /**
   * True when the config needs the client IP (rate-limit / trust-proxy).
   * Callers should pass `undefined` when false to skip the `requestIP` lookup.
   */
  readonly needsIp: boolean;
  /** Release the underlying napi instance + handle. */
  destroy(): void;
}

/**
 * Create a direct C-ABI ingress pre-flight instance (or `null` when the addon
 * lacks the ingress symbols). Each request runs ONE `castrum_ingress_handle_*`
 * call with `cstring` url/ip + the packed headers block, and the 48-byte
 * verdict is decoded with zero TextDecoder/alloc. Terminal decisions build a
 * response with the pre-baked security headers + rate-limit/CORS headers.
 */
export const createNativeIngress = (
  options: NativeIngressOptions = {},
  runtime: NativeIngressRuntime = {},
): NativeIngress | null => {
  const ffiIng = getFfiIngress();
  if (!ffiIng) return null;
  const L = resolveLayout();
  const addon = getNative();
  if (!addon || typeof (addon as { Ingress?: unknown }).Ingress !== "function") return null;

  let instance: { ingressInnerPtr(): bigint };
  try {
    // Cast ONLY the constructor accessor — `new addon(...)` would construct the
    // module (not a constructor); `new IngressCtor(...)` constructs the napi class.
    const IngressCtor = (
      addon as unknown as { Ingress: new (o: unknown) => { ingressInnerPtr(): bigint } }
    ).Ingress;
    instance = new IngressCtor(options);
  } catch {
    return null;
  }
  const inner = Number(instance.ingressInnerPtr());
  if (!inner) return null;

  const plan = buildIngressHeaderPlan(options);
  const trustEnabled = options.trustProxy === true || options.trustedProxies?.enabled === true;
  const rateEnabled = options.rateLimit != null;
  // Fail-closed policy: a native core fault rejects (503) instead of
  // pass-through when enabled — a broken security pipeline must be visible,
  // not silently disabled. Default stays availability-first (pass-through)
  // but every fault is now reported through the telemetry sink.
  const failClosed = resolveFailClosed(runtime.failClosed);
  const securityEntries: ReadonlyArray<[string, string]> = Object.freeze([
    ...(runtime.securityHeaders ?? []),
  ]);
  const outputBufferSize = Math.min(
    MAX_OUTPUT_BUFFER_SIZE,
    Math.max(L.outDataStart, Math.floor(runtime.outputBufferSize ?? DEFAULT_OUTPUT_BUFFER_SIZE)),
  );
  // Per-instance reusable output buffer + cached DataView (no per-request alloc;
  // decoded synchronously before the next request reuses it — same discipline
  // as castrum's BufferPool happy path).
  let output = new Uint8Array(outputBufferSize);
  let outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);

  const corsOpts = options.cors;

  const growOutput = (needed: number): void => {
    if (needed <= output.length) return;
    let cap = output.length * 2;
    while (cap < needed) cap *= 2;
    output = new Uint8Array(Math.min(cap, MAX_OUTPUT_BUFFER_SIZE));
    outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);
  };

  // Pooled per-request objects — consumed synchronously by the caller before
  // the next request reuses them (same discipline as the pooled output buffer
  // and the `withScratch` arena). Eliminates 2 allocations per request off the
  // hot path. The OK `body` is a shared immutable empty view (never mutated).
  const verdict: IngressVerdict = {
    ok: false,
    errorCode: 0,
    status: 0,
    flags: 0,
    rateLimit: 0,
    rateRemaining: 0,
    rateResetMs: 0,
    retryAfterMs: 0,
    headerVariant: 0,
    cookiesJsonLen: 0,
    queryJsonLen: 0,
    bodyJsonLen: 0,
  };
  const okResult: NativePreflightResult = {
    ok: true,
    status: 200,
    terminal: false,
    rateLimited: false,
    requestId: "",
    body: EMPTY_BYTES,
  };

  const runOnce = (request: Request, ip: string | undefined): NativePreflightOutcome => {
    // Shared fault outcome: report, then honor the fail-closed policy (a fault
    // NEVER silently pass-throughs — that hid disabled rate limiting / CORS).
    const fault = (message: string): NativePreflightOutcome => {
      reportDegradation("call-failed", "ingress.handle", message);
      return failClosed ? failClosedResponse() : { terminal: false, response: null, result: null };
    };
    /** One native call with the current output buffer → bytes written. */
    const call = (): number =>
      ffiIng.ingressHandleComponents(
        inner,
        methodKind,
        request.url,
        ip ?? "",
        EMPTY_RID,
        headers,
        null,
        output,
      );

    const methodKind = METHOD_KIND[request.method] ?? METHOD_KIND_UNKNOWN;
    const headers = packSelectedHeaders(request, plan, methodKind);
    growOutput(L.outDataStart);
    // The shared castrum writers THROW on containment (the old in-repo
    // binding returned 0). Contain here so the fault policy (telemetry +
    // fail-closed 503) still governs — never break the request flow.
    let w = 0;
    try {
      w = call();
    } catch (err) {
      return fault(`native ingress call failed: ${String(err)}`);
    }
    if (w === 0) {
      return fault("native ingress returned 0 — security pipeline degraded to pass-through");
    }
    if (w < L.outDataStart) {
      // SHORT WRITE: an incomplete verdict header. Decoding would read STALE
      // fields out of the POOLED verdict object below — cross-request bleed
      // of the previous request's status / rate-limit numbers into this
      // terminal response. Treat exactly like a fault.
      return fault(
        `native ingress wrote ${w}B < verdict header ${L.outDataStart}B — treated as fault`,
      );
    }
    if (w > output.length) {
      growOutput(w);
      try {
        w = call();
      } catch (err) {
        return fault(`native ingress retry failed: ${String(err)}`);
      }
      if (w === 0) {
        return fault(
          "native ingress retry after buffer growth failed — security pipeline degraded",
        );
      }
      if (w < L.outDataStart || w > output.length) {
        return fault(`native ingress retry wrote incomplete verdict (${w}B) — pipeline degraded`);
      }
    }
    const v = decodeVerdict(output, outputView, verdict, L);
    if (v.ok) {
      // Reuse the pooled OK result (consumed synchronously; no per-request
      // object allocation). `ok`/`terminal`/`requestId`/`body` never change;
      // the two mutable fields are written through a pooled mutable slot (the
      // readonly surface is for external callers — callers must not retain the
      // result past the synchronous consumption).
      const slot = okResult as { status: number; rateLimited: boolean };
      slot.status = v.status || 200;
      slot.rateLimited = (v.flags & L.flagRateLimited) !== 0;
      return { terminal: false, response: null, result: okResult };
    }
    // Terminal: build the response (status + baked headers + error body).
    return {
      terminal: true,
      response: buildTerminalResponse(request, v, securityEntries, corsOpts, L),
      result: null,
    };
  };

  return {
    preprocess(request, ip) {
      // Synchronous: the C-ABI core does not await anything, so returning the
      // value directly (not via an `async` fn) avoids a per-request Promise
      // allocation + microtask on every request.
      return runOnce(request, ip);
    },
    needsIp: rateEnabled || trustEnabled,
    destroy() {
      // The napi instance is GC'd when the closure drops; nothing else to free.
      instance = undefined as unknown as { ingressInnerPtr(): bigint };
    },
  };
};
