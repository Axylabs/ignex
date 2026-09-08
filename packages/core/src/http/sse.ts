/**
 * @fileoverview Server-Sent Events (SSE) support.
 * Streaming responses with proper formatting.
 */

import { sseEncode } from "@ignex/native";
import { encoder } from "./encoder";

/** Options for an individual SSE event frame. */
export interface SSEOptions {
  event?: string;
  id?: string;
  retry?: number;
}

/** An SSE event to send: `data` plus optional `event`/`id`/`retry` fields. */
export interface SSEMessage {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

/** Format an SSE event as a wire frame (`event:`/`data:`/`id:`/`retry:` lines). */
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

      /**
       * Backpressure guard: `controller.enqueue` never blocks, so a consumer
       * that stops reading (slow client, dead keep-alive socket) would grow
       * the internal queue without bound while the generator keeps producing.
       * Pause pulling from the generator whenever the stream's desired size
       * is non-positive (consumer is behind), and tear the generator down
       * when the backlog persists — the connection is effectively dead at
       * that point and the generator's timers/loops must be released.
       */
      // Sustained backlog with zero drain progress for this long → treat the
      // consumer as gone. Measured in WALL time, not 1ms-timer ticks: coarse
      // OS timers (e.g. ~15ms clamps on Windows) would otherwise stretch a
      // "~1s teardown" to 15s+ and leak the generator's timers/loops there.
      const BACKPRESSURE_GRACE_MS = 1000;
      const waitDrained = async (): Promise<boolean> => {
        const deadline = Date.now() + BACKPRESSURE_GRACE_MS;
        while (!stopped && !signal?.aborted && (controller.desiredSize ?? 1) <= 0) {
          if (Date.now() >= deadline) return false;
          await new Promise((r) => setTimeout(r, 1));
        }
        return true;
      };

      try {
        for await (const chunk of generator as AsyncGenerator<string | SSEMessage>) {
          if (stopped || signal?.aborted) break;
          const msg = typeof chunk === "string" ? { data: chunk } : chunk;
          controller.enqueue(encoder.encode(formatSSE(msg)));
          if (!(await waitDrained())) {
            stop();
            break;
          }
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
