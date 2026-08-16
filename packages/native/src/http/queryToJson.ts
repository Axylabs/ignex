/**
 * Query / cookie → JSON object TEXT writers.
 *
 * castrum REMOVED the `castrum_query_to_json` / `castrum_cookies_to_json`
 * C-ABI symbols, so these are JS-only now (the previous FFI/NAPI path is
 * gone). The fallback mirrors the native writer's exact semantics: FLAT
 * object, last-wins on duplicate keys (the Rust writer emitted repeated keys;
 * JSON.parse keeps the last). Kept for API compat (no core consumers).
 */

import { cookiePairs } from "./cookie";
import { queryPairs } from "./query";

/** Query string → `{"k":"v",...}` JSON text (flat, last-wins on dupes). */
export const queryToJson = (input: string | Uint8Array): string => queryToJsonFallback(input);

/** Pure-TS fallback for {@link queryToJson} (identical semantics). */
export const queryToJsonFallback = (input: string | Uint8Array): string => {
  const o: Record<string, string> = {};
  for (const [k, v] of queryPairs(input)) o[k] = v;
  return JSON.stringify(o);
};

/** Cookie header → `{"k":"v",...}` JSON text (flat, last-wins on dupes). */
export const cookiesToJson = (input: string | Uint8Array): string => cookiesToJsonFallback(input);

/** Pure-TS fallback for {@link cookiesToJson} (identical semantics). */
export const cookiesToJsonFallback = (input: string | Uint8Array): string => {
  const o: Record<string, string> = {};
  for (const [k, v] of cookiePairs(input)) o[k] = v;
  return JSON.stringify(o);
};
