/**
 * @fileoverview Terminal response builders for the direct C-ABI ingress
 * pipeline — status + baked security headers + CORS headers + the pre-encoded
 * error body (rate-limited bodies inline `retry_after_ms`).
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */
import type { NativeIngressOptions } from "../pipeline";
import { U32_MAX } from "./constants";
import { rateLimitedBody, resolveIngress } from "./errors";
import type { IngressLayout } from "./layout";
import { type IngressVerdict, secondsFromMs } from "./verdict";

/** Build the terminal response from a decoded verdict (status + headers + body). */
export function buildTerminalResponse(
  request: Request,
  v: IngressVerdict,
  securityEntries: ReadonlyArray<[string, string]>,
  cors: NativeIngressOptions["cors"],
  L: IngressLayout,
): Response {
  const { errorStatus, errorBodies } = resolveIngress();
  const hv = v.headerVariant;
  const headers: Array<[string, string]> = [
    ...securityEntries,
    ...buildRateLimitHeaders(v, hv, L),
    ...buildCorsHeaders(request, hv, cors, L),
  ];
  const status = v.status || errorStatus[v.errorCode] || 400;
  const body =
    v.errorCode === L.errRateLimited
      ? rateLimitedBody(v.retryAfterMs || 0)
      : (errorBodies[v.errorCode] ?? errorBodies[L.errInternal]);
  return new Response(body as unknown as BodyInit, { status, headers });
}

/** Rate-limit response headers (limit/remaining/reset + retry-after when limited). */
function buildRateLimitHeaders(
  v: IngressVerdict,
  hv: number,
  L: IngressLayout,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const rateActive = (hv & L.hvRateActive) !== 0;
  const rateLimited = (hv & L.hvRateLimited) !== 0 || v.errorCode === L.errRateLimited;
  if (rateActive) {
    if (v.rateLimit !== U32_MAX) headers.push(["ratelimit-limit", String(v.rateLimit)]);
    headers.push(["ratelimit-remaining", String(v.rateRemaining)]);
    headers.push(["ratelimit-reset", String(secondsFromMs(v.rateResetMs))]);
  }
  if (rateLimited) {
    headers.push(["retry-after", String(secondsFromMs(v.retryAfterMs || 0))]);
  }
  return headers;
}

/** CORS response headers for simple + preflight outcomes (empty when CORS inactive). */
function buildCorsHeaders(
  request: Request,
  hv: number,
  cors: NativeIngressOptions["cors"],
  L: IngressLayout,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const corsSimple = (hv & L.hvCorsSimple) !== 0;
  const corsPreflight = (hv & L.hvCorsPreflight) !== 0;
  if ((corsSimple || corsPreflight) && cors) {
    const origin = request.headers.get("origin");
    if (origin != null) {
      headers.push(["access-control-allow-origin", origin]);
      if (cors.allowCredentials) headers.push(["access-control-allow-credentials", "true"]);
    }
    if (corsPreflight) {
      if (corsAllowMethodsValue(cors))
        headers.push(["access-control-allow-methods", corsAllowMethodsValue(cors)]);
      if (corsAllowHeadersValue(cors))
        headers.push(["access-control-allow-headers", corsAllowHeadersValue(cors)]);
      if (corsMaxAgeValue(cors)) headers.push(["access-control-max-age", corsMaxAgeValue(cors)]);
    }
    if (corsExposeHeadersValue(cors))
      headers.push(["access-control-expose-headers", corsExposeHeadersValue(cors)]);
  }
  return headers;
}

const corsAllowMethodsValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.allowMethods?.join(", ") ?? "";
const corsAllowHeadersValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.allowHeaders?.join(", ") ?? "";
const corsExposeHeadersValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.exposeHeaders?.join(", ") ?? "";
const corsMaxAgeValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.maxAge != null ? String(c.maxAge) : "";
