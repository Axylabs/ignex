/**
 * @fileoverview Opaque-handle instance C-ABI surface (`castrum_*_validate` /
 * `template_render` / `accept_negotiator` / `conditional_*`) — lazy dlopen in
 * its own transport so a castrum build lacking these symbols cannot break the
 * primary `FfiSurface`.
 *
 * Extracted from the pre-split `ffi.ts` (move-only).
 */
import { createRequire } from "node:module";
import { getAddonPath } from "../loader";
import { toBytes } from "../util";
import type { FfiInstancesSurface } from "./types";

/** Empty view passed for absent optional byte sections (body/rid). */
const EMPTY_VIEW = new Uint8Array(0);

let instancesCached: FfiInstancesSurface | null | undefined;

/** Lazy bind of the opaque-handle instance C-ABI surface (`null` when absent). */
export const getFfiInstances = (): FfiInstancesSurface | null => {
  if (instancesCached !== undefined) return instancesCached;
  instancesCached = null;
  if (process.env.IGNEX_NATIVE === "off") return null;

  const path = getAddonPath();
  if (!path) return null;

  type DlopenFn = (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => number | bigint | undefined>; close(): void };

  let dlopen: DlopenFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  try {
    const { symbols } = dlopen(path, {
      castrum_schema_validator_validate: { args: ["u64", "ptr", "usize"], returns: "u8" },
      castrum_template_render: {
        args: ["u64", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      // Rust: `castrum_accept_negotiator_negotiate(inner, header_ptr,
      // header_len)` — a `(ptr,len)` byte pair (NOT a `cstring`). Binding it as
      // `cstring` left the third register uninitialized, so the native side read
      // `header_len` bytes past the string; Linux happened to land a benign
      // value while macOS returned a bogus no-match answer (the cross-platform
      // parity lane caught it). The server-preference sibling IS `cstring`.
      castrum_accept_negotiator_negotiate: {
        args: ["u64", "ptr", "usize"],
        returns: "cstring",
      },
      castrum_accept_negotiator_negotiate_server: {
        args: ["u64", "cstring"],
        returns: "cstring",
      },
      // `ifNoneMatch`/`ifModifiedSince` are `(ptr,len)` byte pairs (Rust:
      // `castrum_conditional_is_not_modified(inner, inm, inm_len, ims, ims_len,
      // flags)`); presence is gated by the flags byte, so absent headers pass
      // an empty view (never null).
      castrum_conditional_is_not_modified: {
        args: ["u64", "ptr", "usize", "ptr", "usize", "u8"],
        returns: "u8",
      },
      castrum_query_validate: { args: ["u64", "cstring"], returns: "u8" },
      castrum_cookie_validate: { args: ["u64", "cstring"], returns: "u8" },
    });
    const s = symbols as Record<string, (...a: unknown[]) => number | bigint | undefined>;
    // Partial binding → treat the surface as absent (see getFfiRoute).
    const required = [
      "castrum_schema_validator_validate",
      "castrum_template_render",
      "castrum_accept_negotiator_negotiate",
      "castrum_conditional_is_not_modified",
    ] as const;
    if (required.some((name) => typeof s[name] !== "function")) return null;
    const hasQueryV = typeof s.castrum_query_validate === "function";
    const hasCookieV = typeof s.castrum_cookie_validate === "function";
    const queryV = s.castrum_query_validate as (...a: unknown[]) => number;
    const cookieV = s.castrum_cookie_validate as (...a: unknown[]) => number;
    instancesCached = {
      schemaQueryValidate: (inner, qs) => (hasQueryV ? Number(queryV(inner, qs)) === 1 : false),
      schemaCookieValidate: (inner, header) =>
        hasCookieV ? Number(cookieV(inner, header)) === 1 : false,
      schemaValidatorValidate: (inner, doc) =>
        Number(s.castrum_schema_validator_validate?.(inner, doc, doc.length) ?? 0) === 1,
      templateRender: (inner, context, out) =>
        Number(s.castrum_template_render?.(inner, context, context.length, out, out.length) ?? 0),
      acceptNegotiatorNegotiate: (inner, header) => {
        // `(ptr,len)` byte pair (see the symbol table) — encode once and pass
        // the EXACT length; a `cstring` binding left the length uninitialized.
        const fn = s.castrum_accept_negotiator_negotiate;
        if (typeof fn !== "function") return null;
        const bytes = toBytes(header);
        const v = fn(inner, bytes, bytes.length);
        return typeof v === "string" ? v : null;
      },
      acceptNegotiatorNegotiateServer: (inner, header) => {
        const fn = s.castrum_accept_negotiator_negotiate_server;
        if (typeof fn !== "function") return undefined;
        const v = fn(inner, header);
        return typeof v === "string" ? v : null;
      },
      conditionalIsNotModified: (inner, ifNoneMatch, ifModifiedSince) => {
        // `(ptr,len)` pairs: pass the header bytes; absent headers pass an
        // empty view (the flags bits gate reads on the Rust side — the pointer
        // is never dereferenced when the corresponding bit is clear).
        const flags = (ifNoneMatch === null ? 0 : 1) | (ifModifiedSince === null ? 0 : 2);
        const inm = ifNoneMatch === null ? EMPTY_VIEW : toBytes(ifNoneMatch);
        const ims = ifModifiedSince === null ? EMPTY_VIEW : toBytes(ifModifiedSince);
        return (
          Number(
            s.castrum_conditional_is_not_modified?.(
              inner,
              inm,
              inm.length,
              ims,
              ims.length,
              flags,
            ) ?? 0,
          ) === 1
        );
      },
    };
  } catch {
    // Addon lacks the instance surface — not an error.
    instancesCached = null;
  }
  return instancesCached;
};
