/**
 * @fileoverview The `bun:ffi` dlopen of the castrum scalar cores — the raw
 * symbol-table bind for the primary C-ABI surface.
 *
 * Extracted from the pre-split `ffi/bind.ts` (move-only): returns `null` when
 * `bun:ffi` itself cannot be required (silent — this branch is already guarded
 * by `isBun()`); a failed `dlopen` call propagates so the caller's `bind()`
 * keeps its `IGNEX_FFI_MODE=ffi` rethrow + degradation semantics.
 */

import { createRequire } from "node:module";

// Minimal structural type for `bun:ffi`'s `dlopen` — avoids a
// `typeof import("bun:ffi")` annotation so the CLI/root tsconfigs (which
// don't always ship Bun's module types) still typecheck. The actual module is
// required dynamically at runtime (Bun-only; guarded by isBun()).
type DlopenFn = (
  path: string,
  symbols: Record<string, { args: readonly string[]; returns: string }>,
) => { symbols: Record<string, (...a: unknown[]) => number | bigint>; close(): void };

/** The bound castrum scalar-core symbol table, or `null` when bun:ffi is missing. */
export const dlopenSymbols = (
  path: string,
): Record<string, (...a: unknown[]) => number | bigint> | null => {
  let dlopen: DlopenFn;
  try {
    // `bun:ffi` is Bun-only — require it dynamically so Node never trips on
    // the bare specifier (this branch already guarded by isBun()).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  const { symbols } = dlopen(path, {
    castrum_fnv1a64: { args: ["ptr", "usize"], returns: "u64" },
    castrum_crc32: { args: ["ptr", "usize"], returns: "u32" },
    castrum_json_valid: { args: ["ptr", "usize"], returns: "u8" },
    // Validators: the byte-exact `(ptr,len)` pair is PREFERRED (NUL-safe and
    // faster — castrum measured email 236→110ns, uuid 153→50ns, ipv4
    // 118→37ns). The `cstring` symbols stay bound as a fallback for an addon
    // predating 0.9.6; the surface method picks the byte pair when present.
    castrum_validate_email_bytes: { args: ["ptr", "usize"], returns: "u8" },
    castrum_validate_uuid_bytes: { args: ["ptr", "usize"], returns: "u8" },
    castrum_validate_ipv4_bytes: { args: ["ptr", "usize"], returns: "u8" },
    castrum_validate_ipv6_bytes: { args: ["ptr", "usize"], returns: "u8" },
    castrum_validate_email: { args: ["cstring"], returns: "u8" },
    castrum_validate_uuid: { args: ["cstring"], returns: "u8" },
    castrum_validate_ipv4: { args: ["cstring"], returns: "u8" },
    castrum_validate_ipv6: { args: ["cstring"], returns: "u8" },
    castrum_hmac_sha256: {
      args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
      returns: "usize",
    },
    castrum_hmac_sha256_verify: {
      args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
      returns: "u8",
    },
    castrum_sign_cookie: { args: ["ptr", "usize", "ptr", "usize"], returns: "cstring" },
    castrum_verify_cookie: { args: ["ptr", "usize", "ptr", "usize"], returns: "cstring" },
    castrum_csrf_token: { args: ["ptr", "usize"], returns: "cstring" },
    castrum_csrf_verify: { args: ["ptr", "usize", "ptr", "usize"], returns: "u8" },
    castrum_etag: { args: ["ptr", "usize", "u8"], returns: "cstring" },
    castrum_random_token: { args: ["u32"], returns: "cstring" },
    castrum_query_parse_packed: {
      args: ["ptr", "usize", "ptr", "usize"],
      returns: "usize",
    },
    castrum_cookie_parse_packed: {
      args: ["ptr", "usize", "ptr", "usize"],
      returns: "usize",
    },
    castrum_form_parse_packed: {
      args: ["ptr", "usize", "ptr", "usize"],
      returns: "usize",
    },
    // `ws_accept_key` takes a `cstring` ARG + returns `cstring` (engine-cloned).
    castrum_ws_accept_key: { args: ["cstring"], returns: "cstring" },
    castrum_jwt_sign_bytes: {
      args: ["ptr", "usize", "ptr", "usize", "i64", "i64"],
      returns: "cstring",
    },
    castrum_jwt_verify: {
      args: ["ptr", "usize", "ptr", "usize", "i64"],
      returns: "cstring",
    },
    // Ed25519 / EdDSA JWT (RBAC auth)
    castrum_ed25519_generate_keypair: { args: ["ptr", "usize"], returns: "usize" },
    castrum_ed25519_sign: {
      args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
      returns: "usize",
    },
    castrum_ed25519_verify: {
      args: ["ptr", "usize", "ptr", "usize", "ptr", "usize"],
      returns: "u8",
    },
    castrum_jwt_eddsa_sign: {
      args: ["ptr", "usize", "ptr", "usize", "i64", "i64"],
      returns: "cstring",
    },
    castrum_jwt_eddsa_verify: {
      args: ["ptr", "usize", "ptr", "usize", "i64"],
      returns: "cstring",
    },
    castrum_brotli_compress: {
      args: ["ptr", "usize", "u32", "ptr", "usize"],
      returns: "usize",
    },
    castrum_brotli_decompress: {
      args: ["ptr", "usize", "usize", "ptr", "usize"],
      returns: "usize",
    },
    castrum_aead_encrypt: {
      args: ["ptr", "usize", "ptr", "usize", "ptr", "usize", "u8", "ptr", "usize"],
      returns: "usize",
    },
    castrum_aead_decrypt: {
      args: ["ptr", "usize", "ptr", "usize", "ptr", "usize", "u8", "ptr", "usize"],
      returns: "usize",
    },
  });
  return symbols;
};
