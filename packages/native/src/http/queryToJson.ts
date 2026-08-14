/**
 * Query / cookie → JSON object TEXT writers.
 *
 * Native (C-ABI, `bun:ffi`) path calls the Rust `castrum_query_to_json` /
 * `castrum_cookies_to_json` symbols, which parse the raw query string / Cookie
 * header AND write the JSON text in one zero-allocation Rust pass — no JS
 * pairs array, no Record, no per-value strings. The JS fallback mirrors the
 * native writer's exact semantics: FLAT object, last-wins on duplicate keys
 * (the Rust writer emits repeated keys; JSON.parse keeps the last).
 *
 * Selection: `queryToJson`/`cookiesToJson` are native only while the C-ABI
 * transport is live (FFI_WINS in runtime.ts). See scripts/select-native.ts.
 */

import { readString } from "../ffi-read";
import { nativeFor } from "../runtime";
import { toBytes } from "../util";
import { cookiePairs } from "./cookie";
import { queryPairs } from "./query";

/** Query string → `{"k":"v",...}` JSON text (flat, last-wins on dupes). */
export const queryToJson = (input: string | Uint8Array): string => {
  const n = nativeFor("queryToJson");
  if (n) {
    const bytes = typeof input === "string" ? toBytes(input) : input;
    const out = (n as unknown as { queryToJson(b: Uint8Array): string | Uint8Array }).queryToJson(
      bytes,
    );
    // C-ABI returns a plain string (cstring — engine clones it natively); the
    // NAPI fallback (if one ships) returns bytes. Both are decoded exactly.
    return typeof out === "string" ? out : readString(out, 0, out.byteLength);
  }
  return queryToJsonFallback(input);
};

/** Pure-TS fallback for {@link queryToJson} (identical semantics). */
export const queryToJsonFallback = (input: string | Uint8Array): string => {
  const o: Record<string, string> = {};
  for (const [k, v] of queryPairs(input)) o[k] = v;
  return JSON.stringify(o);
};

/** Cookie header → `{"k":"v",...}` JSON text (flat, last-wins on dupes). */
export const cookiesToJson = (input: string | Uint8Array): string => {
  const n = nativeFor("cookiesToJson");
  if (n) {
    const bytes = typeof input === "string" ? toBytes(input) : input;
    const out = (
      n as unknown as { cookiesToJson(b: Uint8Array): string | Uint8Array }
    ).cookiesToJson(bytes);
    return typeof out === "string" ? out : readString(out, 0, out.byteLength);
  }
  return cookiesToJsonFallback(input);
};

/** Pure-TS fallback for {@link cookiesToJson} (identical semantics). */
export const cookiesToJsonFallback = (input: string | Uint8Array): string => {
  const o: Record<string, string> = {};
  for (const [k, v] of cookiePairs(input)) o[k] = v;
  return JSON.stringify(o);
};
