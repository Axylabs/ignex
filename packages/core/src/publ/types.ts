/**
 * @fileoverview Public sub-barrel: the shared types + AOT contract re-exported
 * from the `@ignex/core` entry (split from the barrel `src/index.ts` by section
 * banner — move-only; `export` statements verbatim).
 */

// ── types ───────────────────────────────────────────────────────
export type {
  AnySchema,
  ContextUsage,
  CookieOptions,
  HookContainer,
  HttpMethod,
  LifeCycleStore,
  RouteSchema,
  ServerWebSocket,
  StandardSchemaV1,
  Static,
  TSchema,
  WebSocketHandler,
} from "../types";
export { EMPTY_LIFECYCLE, EMPTY_USAGE, FULL_USAGE, HTTP_METHODS } from "../types";
