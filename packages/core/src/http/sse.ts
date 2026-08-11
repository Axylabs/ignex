/**
 * @fileoverview Server-Sent Events (SSE) support.
 * Streaming responses with proper formatting.
 */

import { sseEncode } from "@ignus/native";

export interface SSEOptions {
  event?: string;
  id?: string;
  retry?: number;
}

export interface SSEMessage {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export const formatSSE = (msg: SSEMessage): string =>
  sseEncode(msg.event ?? null, msg.data, msg.id ?? null, msg.retry ?? null);

/**
 * Build an SSE streaming `Response` from a generator.
 *
 * The generator is torn down when the client disconnects (stream `cancel`)
 * or when the caller-supplied `signal` aborts, so generators that own timers,
 * polling loops or long-lived connections can release them instead of leaking.
 */
export const sse = (
  generator: AsyncGenerator<string | SSEMessage> | Generator<string | SSEMessage>,
  init?: ResponseInit,
  options: { signal?: AbortSignal } = {},
): Response => {
  const encoder = new TextEncoder();
  const { signal } = options;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      const result = (generator as unknown as { return?: (value?: unknown) => unknown }).return?.(
        undefined,
      );
      // Async generators return a promise — swallow rejection to avoid an
      // unhandled rejection when the generator is already closed.
      if (result && typeof (result as Promise<unknown>)?.then === "function") {
        void (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* generator may be mid-iteration; safe to ignore */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = (): void => {
        stop();
      };

      if (signal) {
        if (signal.aborted) stop();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        for await (const chunk of generator as AsyncGenerator<string | SSEMessage>) {
          if (stopped || signal?.aborted) break;
          const msg = typeof chunk === "string" ? { data: chunk } : chunk;
          controller.enqueue(encoder.encode(formatSSE(msg)));
        }
      } catch {
        /* stream closed */
      } finally {
        signal?.removeEventListener("abort", onAbort);
        stop();
        try {
          controller.close();
        } catch {
          // Already closed/cancelled by the consumer.
        }
      }
    },
    cancel() {
      // Client disconnected — stop the generator so it can release timers/loops.
      stop();
    },
  });

  return new Response(stream, {
    ...init,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...init?.headers,
    },
  });
};
