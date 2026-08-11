/**
 * @fileoverview HTTP method vocabulary shared by the compiler and core.
 *
 * Single source of truth for the method union so route-file parsing
 * (compiler) and the runtime types (core) never drift apart. `WS` is part
 * of the runtime vocabulary (websocket upgrade); the compiler's filename
 * suffix normalization only ever matches the non-`WS` subset.
 */

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
  "WS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
