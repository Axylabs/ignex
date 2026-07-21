/**
 * Distributed tracing helpers.
 *
 * Fixed:
 * - uses crypto.randomUUID()
 * - does not mutate response headers directly
 */

export type TraceEvent =
  | "request"
  | "parse"
  | "transform"
  | "beforeHandle"
  | "handle"
  | "afterHandle"
  | "mapResponse"
  | "afterResponse"
  | "error";

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
  const traceId =
    req.headers.get("x-trace-id") ||
    req.headers.get("x-request-id") ||
    crypto.randomUUID();

  return { traceId, start: performance.now() };
};

export const finishTrace = (
  _req: Request,
  trace: { traceId: string; start: number },
  response: Response
): Response => {
  const duration = performance.now() - trace.start;

  const headers = new Headers(response.headers);
  headers.set("x-trace-id", trace.traceId);
  headers.set("x-response-time", duration.toFixed(2) + "ms");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
