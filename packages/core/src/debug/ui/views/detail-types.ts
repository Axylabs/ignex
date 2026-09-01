/**
 * @fileoverview Structural span shape shared by detail sub-renderers (the
 * wire type lives in types.ts; this local mirror keeps the UI bundle free of
 * server-only imports while staying aligned via the shared field names).
 */

/** Minimal span surface the waterfall/queries/tree renderers rely on. */
export interface SpanLike {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  startMs: number;
  durationMs: number;
  open?: boolean;
  attrs?: Record<string, unknown> | null;
  error?: string | null;
  origin?: string | null;
}

/** Minimal request-trace surface the detail view consumes. */
export interface DetailTrace {
  id: string;
  ts: number;
  method: string;
  path: string;
  route?: string | null;
  status: number;
  requestId: string;
  ip: string;
  durationMs: number;
  error?: string | null;
  errorStack?: string | null;
  stages?: string[];
  spans: SpanLike[];
  dbCount: number;
  dbTimeMs: number;
  curl?: string | null;
  sourceFile?: string | null;
  request: { url: string; headers: Record<string, string>; body?: string | null };
  responseHeaders?: Record<string, string> | null;
  responseBody?: string | null;
  responseBodyTruncated?: boolean;
}
