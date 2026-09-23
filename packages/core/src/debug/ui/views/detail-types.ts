/**
 * @fileoverview Structural span shape shared by detail sub-renderers (the
 * wire type lives in types.ts; this local mirror keeps the UI bundle free of
 * server-only imports while staying aligned via the shared field names).
 *
 * The fault classification is imported (type-only) from the wire types rather
 * than mirrored, because it is the one thing the dashboard must never
 * paraphrase — the card has to show exactly the fault the server recorded.
 */

import type { FaultMark, TraceFault, TraceFrames } from "../../types";

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
  /** Classification of the failure that ended this span (`code`/`origin`/`kind`). */
  fault?: FaultMark | null;
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
  /** The classified failure behind `error` (origin, kind, code, hints, causes). */
  fault?: TraceFault | null;
  /** Id of the span that failed — the waterfall points at the stage. */
  faultSpanId?: number | null;
  /**
   * The failure's frames, business logic first: `appWhere` is the line in YOUR
   * code, `app`/`internal` are the two groups the stack card renders.
   */
  faultFrames?: TraceFrames | null;
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
