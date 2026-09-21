/**
 * @fileoverview Ingress wire layout — the slot order of the 38×u32 layout blob
 * (`rust/ffi.rs` IngressLayout), the Rust-parity default, and the cached
 * resolver that projects the blob into a typed {@link IngressLayout}.
 *
 * The offsets / flags / header-variant bits / error codes are OWNED by Rust
 * (`rust/ingress/output.rs` + `rust/ffi.rs`) and projected to JS at runtime via
 * `castrum_ingress_layout`, so a layout change in Rust needs NO TS edit.
 * `DEFAULT_LAYOUT` is the parity safety net used only when the blob cannot be
 * read; the values are pinned to output.rs by `scripts/verify-native-ffi.ts` /
 * the ingress parity tests.
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */
import { getFfiIngress } from "../ffi";

/** Slot order of the 38×u32 ingress layout blob (`rust/ffi.rs` IngressLayout). */
const SLOT = {
  OUT_VERDICT: 0,
  OUT_ERROR_CODE: 1,
  OUT_STATUS: 2,
  OUT_FLAGS: 3,
  OUT_RATE_LIMIT: 4,
  OUT_RATE_REMAINING: 5,
  OUT_RATE_RESET: 6,
  OUT_RETRY_AFTER: 7,
  OUT_COOKIES_JSON_LEN: 8,
  OUT_QUERY_JSON_LEN: 9,
  OUT_HEADER_VARIANT: 10,
  OUT_BODY_JSON_LEN: 11,
  OUT_DATA_START: 12,
  FLAG_RATE_LIMITED: 19,
  HV_CORS_SIMPLE: 24,
  HV_CORS_PREFLIGHT: 25,
  HV_RATE_ACTIVE: 26,
  HV_RATE_LIMITED: 27,
  ERR_CORS_PREFLIGHT: 30,
  ERR_RATE_LIMITED: 31,
  ERR_BODY_TOO_LARGE: 32,
  ERR_INVALID_JSON: 33,
  ERR_SCHEMA_VALIDATION: 34,
  ERR_BAD_REQUEST: 35,
  ERR_REQUEST_TOO_LARGE: 36,
  ERR_INTERNAL: 37,
} as const;

/** The Rust-owned ingress wire layout (offsets / bits / codes). */
export interface IngressLayout {
  readonly outVerdict: number; // u8
  readonly outErrorCode: number; // u8
  readonly outStatus: number; // u16 LE
  readonly outFlags: number; // u32
  readonly outRateLimit: number; // u32
  readonly outRateRemaining: number; // u32
  readonly outRateReset: number; // u64 ms
  readonly outRetryAfter: number; // u64 ms
  readonly outCookiesJsonLen: number; // u32
  readonly outQueryJsonLen: number; // u32
  readonly outHeaderVariant: number; // u8
  readonly outBodyJsonLen: number; // u32
  readonly outDataStart: number;
  readonly flagRateLimited: number;
  readonly hvCorsSimple: number;
  readonly hvCorsPreflight: number;
  readonly hvRateActive: number;
  readonly hvRateLimited: number;
  readonly errCorsPreflight: number;
  readonly errRateLimited: number;
  readonly errBodyTooLarge: number;
  readonly errInvalidJson: number;
  readonly errSchemaValidation: number;
  readonly errBadRequest: number;
  readonly errRequestTooLarge: number;
  readonly errInternal: number;
}

/** Parity safety net — identical to `rust/ingress/output.rs` (see module doc). */
const DEFAULT_LAYOUT: IngressLayout = {
  outVerdict: 0,
  outErrorCode: 1,
  outStatus: 2,
  outFlags: 4,
  outRateLimit: 8,
  outRateRemaining: 12,
  outRateReset: 16,
  outRetryAfter: 24,
  outCookiesJsonLen: 32,
  outQueryJsonLen: 36,
  outHeaderVariant: 40,
  outBodyJsonLen: 44,
  outDataStart: 48,
  flagRateLimited: 1 << 6,
  hvCorsSimple: 2,
  hvCorsPreflight: 4,
  hvRateActive: 8,
  hvRateLimited: 16,
  errCorsPreflight: 1,
  errRateLimited: 2,
  errBodyTooLarge: 3,
  errInvalidJson: 4,
  errSchemaValidation: 5,
  errBadRequest: 6,
  errRequestTooLarge: 7,
  errInternal: 8,
};

/** Word count of the `castrum_ingress_layout` blob (38 × u32 LE). */
const LAYOUT_BLOB_WORDS = 38;

let cachedLayout: IngressLayout | null = null;
/** Resolve the ingress layout from Rust once (cached; never throws). */
export function resolveLayout(): IngressLayout {
  if (cachedLayout) return cachedLayout;
  let L = DEFAULT_LAYOUT;
  const ffiIng = getFfiIngress();
  if (ffiIng) {
    try {
      const buf = new Uint8Array(LAYOUT_BLOB_WORDS * 4);
      if (ffiIng.ingressLayout(buf) >= LAYOUT_BLOB_WORDS * 4) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const get = (slot: number): number => view.getUint32(slot * 4, true);
        L = {
          outVerdict: get(SLOT.OUT_VERDICT),
          outErrorCode: get(SLOT.OUT_ERROR_CODE),
          outStatus: get(SLOT.OUT_STATUS),
          outFlags: get(SLOT.OUT_FLAGS),
          outRateLimit: get(SLOT.OUT_RATE_LIMIT),
          outRateRemaining: get(SLOT.OUT_RATE_REMAINING),
          outRateReset: get(SLOT.OUT_RATE_RESET),
          outRetryAfter: get(SLOT.OUT_RETRY_AFTER),
          outCookiesJsonLen: get(SLOT.OUT_COOKIES_JSON_LEN),
          outQueryJsonLen: get(SLOT.OUT_QUERY_JSON_LEN),
          outHeaderVariant: get(SLOT.OUT_HEADER_VARIANT),
          outBodyJsonLen: get(SLOT.OUT_BODY_JSON_LEN),
          outDataStart: get(SLOT.OUT_DATA_START),
          flagRateLimited: get(SLOT.FLAG_RATE_LIMITED),
          hvCorsSimple: get(SLOT.HV_CORS_SIMPLE),
          hvCorsPreflight: get(SLOT.HV_CORS_PREFLIGHT),
          hvRateActive: get(SLOT.HV_RATE_ACTIVE),
          hvRateLimited: get(SLOT.HV_RATE_LIMITED),
          errCorsPreflight: get(SLOT.ERR_CORS_PREFLIGHT),
          errRateLimited: get(SLOT.ERR_RATE_LIMITED),
          errBodyTooLarge: get(SLOT.ERR_BODY_TOO_LARGE),
          errInvalidJson: get(SLOT.ERR_INVALID_JSON),
          errSchemaValidation: get(SLOT.ERR_SCHEMA_VALIDATION),
          errBadRequest: get(SLOT.ERR_BAD_REQUEST),
          errRequestTooLarge: get(SLOT.ERR_REQUEST_TOO_LARGE),
          errInternal: get(SLOT.ERR_INTERNAL),
        };
      }
    } catch {
      // The blob read failed — keep the parity defaults (identical numbers).
    }
  }
  cachedLayout = L;
  return L;
}
