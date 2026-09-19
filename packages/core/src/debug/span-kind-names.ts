import type { SpanKind } from "./types";

/** Shared span inventory and descriptions for knowledge collection and rendering. */
export const spanKindNames: Record<SpanKind, string> = {
  request: "the request itself",
  lifecycle: "framework lifecycle stages",
  db: "database queries / transactions",
  cache: "cache operations",
  http: "outbound HTTP calls",
  render: "template rendering / static file serving",
  auth: "authentication / sessions / security checks",
  custom: "application code",
  error: "failed operations",
};
