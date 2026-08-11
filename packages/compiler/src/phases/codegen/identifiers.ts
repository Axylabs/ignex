/**
 * @fileoverview Codegen: generated-identifier naming conventions.
 *
 * Every name the emitter produces for a route/helper lives here so naming
 * stays consistent and is easy to change in one place.
 */

import type { RouteDef } from "../../types";

export const handlerImportName = (route: RouteDef): string => `handler_${route.handlerRef}`;

export const methodHandlerName = (route: RouteDef): string => `${route.method}_${route.handlerRef}`;

export const constantBodyVar = (route: RouteDef): string => `BODY_${route.handlerRef}`;

export const constantInitVar = (route: RouteDef): string => `INIT_${route.handlerRef}`;

export const hookIdent = (name: string): string => `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

export const cacheVar = (route: RouteDef): string => `CACHE_${route.handlerRef}`;

export const coreHandlerName = (route: RouteDef, hasCache: boolean): string =>
  hasCache ? `core_${route.handlerRef}` : methodHandlerName(route);

export const validatorImportName = (route: RouteDef, kind: string): string =>
  `validate_${route.handlerRef}_${kind}`;

export const serializerImportName = (route: RouteDef, status: string): string =>
  `serialize_${route.handlerRef}_${status}`;

export const routeReplyFn = (route: RouteDef): string => {
  if (route.responseType === "text") return "textReply";
  if (route.responseType === "html") return "htmlReply";
  if (route.responseType === "stream") return "streamReply";
  return "jsonReply";
};

/** Extract `*name` wildcard identifiers from a path. */
export const wildcardNames = (path: string): string[] =>
  Array.from(path.matchAll(/\*([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);

// ── Route-table naming ───────────────────────────────────────────

export const BUN_ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex source for an exact-path matcher with `:param`/`*wildcard` segments. */
export const allowRegExp = (path: string): string => {
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return "[^/]+";
      if (segment.startsWith("*")) return ".*";
      return escapeRegExp(segment);
    })
    .join("/");

  return `^${pattern}$`;
};

/** Handler name used in the route table, honoring deduplication. */
export const routeHandlerName = (route: RouteDef): string =>
  route.dedupGroup ? `${route.method}_${route.dedupGroup}` : methodHandlerName(route);
