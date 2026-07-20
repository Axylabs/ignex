/**
 * @fileoverview Server-Sent Events (SSE) support.
 * Streaming responses with proper formatting.
 */

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

export const formatSSE = (msg: SSEMessage): string => {
  let out = "";
  if (msg.id) out += `id: ${msg.id}\n`;
  if (msg.event) out += `event: ${msg.event}\n`;
  if (msg.retry) out += `retry: ${msg.retry}\n`;
  out += `data: ${msg.data}\n\n`;
  return out;
};

export const sse = (
  generator: AsyncGenerator<string | SSEMessage> | Generator<string | SSEMessage>,
  init?: ResponseInit
): Response => {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator as AsyncGenerator<string | SSEMessage>) {
          const msg = typeof chunk === "string" ? { data: chunk } : chunk;
          controller.enqueue(encoder.encode(formatSSE(msg)));
        }
      } catch { /* stream closed */ }
      finally { controller.close(); }
    }
  });

  return new Response(stream, {
    ...init,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...init?.headers,
    },
  });
};

export const sseFromStream = (stream: ReadableStream, init?: ResponseInit): Response =>
  new Response(stream, {
    ...init,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...init?.headers,
    },
  });