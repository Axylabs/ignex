/**
 * @fileoverview Distributed Tracing — OpenTelemetry-compatible.
 */

import type { FluxContext } from "./context";

export type TraceEvent =
  | "request" | "parse" | "transform" | "beforeHandle"
  | "handle" | "afterHandle" | "mapResponse" | "afterResponse" | "error";

export interface TraceSpan {
  id: string;
  name: string;
  event: TraceEvent;
  begin: number;
  end?: number;
  error?: Error | null;
  attributes?: Record<string, unknown>;
  children: TraceSpan[];
}

export interface TraceContext {
  traceId: string;
  spans: TraceSpan[];
  startSpan(name: string, event: TraceEvent): TraceSpan;
  endSpan(span: TraceSpan, error?: Error | null): void;
}

let traceCounter = 0;

export const createTraceContext = (requestId: string): TraceContext => {
  const spans: TraceSpan[] = [];

  return {
    traceId: requestId,
    spans,
    startSpan(name, event) {
      const span: TraceSpan = {
        id: `${requestId}-${++traceCounter}`,
        name,
        event,
        begin: performance.now(),
        children: [],
      };
      spans.push(span);
      return span;
    },
    endSpan(span, error = null) {
      span.end = performance.now();
      span.error = error;
    },
  };
};

export const startTrace = (req: Request): { traceId: string; start: number } => {
  const traceId = req.headers.get("x-trace-id") || req.headers.get("x-request-id") || Math.random().toString(36).slice(2);
  return { traceId, start: performance.now() };
};

export const finishTrace = (
  req: Request,
  trace: { traceId: string; start: number },
  response: Response
): Response => {
  const duration = performance.now() - trace.start;
  response.headers.set("x-trace-id", trace.traceId);
  response.headers.set("x-response-time", `${duration.toFixed(2)}ms`);
  return response;
};