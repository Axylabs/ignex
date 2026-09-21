/**
 * @fileoverview Pre-encoded error bodies (benchmark wire, castrum-parity) —
 * terminal status + body tables keyed by the Rust-owned error codes, plus the
 * rate-limited body with an inlined `retry_after_ms`.
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */
import { encoder } from "../util";
import type { IngressLayout } from "./layout";
import { resolveLayout } from "./layout";

const staticErrorBody = (code: string, message: string): Uint8Array =>
  encoder.encode(`{"ok":false,"error":{"code":"${code}","message":"${message}"}}`);

/** Terminal tables keyed by the Rust-owned error codes (built once from the layout). */
interface ResolvedIngress {
  readonly L: IngressLayout;
  readonly errorStatus: Readonly<Record<number, number>>;
  readonly errorBodies: Readonly<Record<number, Uint8Array>>;
}

let cachedResolved: ResolvedIngress | null = null;
/** Resolve the layout + error tables once (cached; never throws). */
export function resolveIngress(): ResolvedIngress {
  if (cachedResolved) return cachedResolved;
  const L = resolveLayout();
  cachedResolved = {
    L,
    errorStatus: {
      [L.errCorsPreflight]: 403,
      [L.errRateLimited]: 429,
      [L.errBodyTooLarge]: 413,
      [L.errInvalidJson]: 400,
      [L.errSchemaValidation]: 422,
      [L.errBadRequest]: 400,
      [L.errRequestTooLarge]: 413,
      [L.errInternal]: 500,
    },
    errorBodies: {
      [L.errCorsPreflight]: staticErrorBody(
        "cors_preflight_not_allowed",
        "CORS preflight not allowed",
      ),
      [L.errRateLimited]: staticErrorBody("rate_limited", "Too Many Requests"),
      [L.errBodyTooLarge]: staticErrorBody("body_too_large", "Request body is too large"),
      [L.errInvalidJson]: staticErrorBody("invalid_json", "Invalid JSON body"),
      [L.errSchemaValidation]: staticErrorBody(
        "schema_validation_failed",
        "Request body failed schema validation",
      ),
      [L.errBadRequest]: staticErrorBody("bad_request", "Bad request"),
      [L.errRequestTooLarge]: staticErrorBody("request_too_large", "Request too large"),
      [L.errInternal]: staticErrorBody("internal_error", "Internal server error"),
    },
  };
  return cachedResolved;
}

const RATE_LIMIT_BODY_PREFIX = encoder.encode(
  '{"ok":false,"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":',
);
const RATE_LIMIT_BODY_SUFFIX = encoder.encode("}}");

/** Rate-limited error body with `retry_after_ms` inlined. */
export function rateLimitedBody(retryAfterMs: number): Uint8Array {
  const digits = encoder.encode(String(Math.max(0, Math.floor(retryAfterMs))));
  const out = new Uint8Array(
    RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength + RATE_LIMIT_BODY_SUFFIX.byteLength,
  );
  out.set(RATE_LIMIT_BODY_PREFIX, 0);
  out.set(digits, RATE_LIMIT_BODY_PREFIX.byteLength);
  out.set(RATE_LIMIT_BODY_SUFFIX, RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength);
  return out;
}
