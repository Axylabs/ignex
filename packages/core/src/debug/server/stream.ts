/**
 * @fileoverview Live revision stream — a Server-Sent-Events channel that
 * replaces blind 5-second polling. The server pushes one tiny JSON frame per
 * mutation burst (coalesced by checking the revision counters on a fast
 * interval), and the dashboard refetches only the endpoints whose domain
 * actually moved.
 *
 * Auth model: EventSource cannot send custom headers, and query-string tokens
 * were explicitly designed out of this API (access-log hygiene). Instead the
 * client mints a SHORT-TTL TICKET (`POST /api/stream/ticket`, authorized via
 * the normal header/cookie gate) and presents it once at connect time.
 * Tickets are single-use, expire quickly, and never equal the real token.
 */

import type { IgnexContext } from "../../http/context";
import type { RevisionCounters } from "./revisions";

/** Ticket lifetime: long enough for connect latency, short enough to be useless if leaked. */
const TICKET_TTL_MS = 15_000;
/** How often the stream checks for counter movement (frame coalescing). */
const POLL_INTERVAL_MS = 300;
/** SSE comment heartbeat to keep intermediaries from idling the connection out. */
const HEARTBEAT_MS = 15_000;

interface TicketEntry {
  expiresAt: number;
}

export interface StreamHub {
  /** Mint a single-use ticket (called by POST /api/stream/ticket). */
  mintTicket: () => string;
  /** Consume a ticket; false when unknown/expired/already used. */
  consumeTicket: (ticket: string) => boolean;
  /** Serve `GET /api/stream?ticket=…` as an SSE response. */
  handle: (ctx: IgnexContext, ticket: string | null) => Response;
  /** Stop the stream's timers (plugin close). */
  stop: () => void;
}

/** Create the hub bound to one plugin instance's counters. */
export const createStreamHub = (counters: RevisionCounters): StreamHub => {
  const tickets = new Map<string, TicketEntry>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  // Lazy ticket sweeper — only runs while tickets exist.
  const ensureSweeper = (): void => {
    if (sweeper !== null) return;
    sweeper = setInterval(
      (): void => {
        const now = Date.now();
        for (const [key, entry] of tickets) {
          if (entry.expiresAt < now) tickets.delete(key);
        }
        if (tickets.size === 0 && sweeper !== null) {
          clearInterval(sweeper);
          sweeper = null;
        }
      },
      Math.max(TICKET_TTL_MS / 2, 1000),
    );
    sweeper.unref?.();
  };

  const consumeTicket = (ticket: string): boolean => {
    const entry = ticket === "" ? undefined : tickets.get(ticket);
    if (entry === undefined || entry.expiresAt < Date.now()) return false;
    tickets.delete(ticket); // single use
    return true;
  };

  const handle = (ctx: IgnexContext, ticket: string | null): Response => {
    if (ticket === null || !consumeTicket(ticket)) {
      return new Response("forbidden\n", { status: 403 });
    }
    let lastEpoch = counters.snapshot().epoch;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        let closed = false;
        const send = (payload: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(payload));
          } catch {
            closed = true;
          }
        };
        // Reconnect hint + initial hello so the client flips its live-dot fast.
        send("retry: 2000\n\n");
        send(`event: revision\ndata: ${JSON.stringify(counters.snapshot())}\n\n`);

        const poll = setInterval((): void => {
          const frame = counters.snapshot();
          if (frame.epoch !== lastEpoch) {
            lastEpoch = frame.epoch;
            send(`event: revision\ndata: ${JSON.stringify(frame)}\n\n`);
          }
        }, POLL_INTERVAL_MS);
        poll.unref?.();

        const beat = setInterval((): void => {
          send(": keepalive\n\n");
        }, HEARTBEAT_MS);
        beat.unref?.();

        const cleanup = (): void => {
          closed = true;
          clearInterval(poll);
          clearInterval(beat);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        ctx.req.signal?.addEventListener?.("abort", cleanup, { once: true });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  };

  return {
    mintTicket: (): string => {
      const ticket = crypto.randomUUID();
      tickets.set(ticket, { expiresAt: Date.now() + TICKET_TTL_MS });
      ensureSweeper();
      return ticket;
    },
    consumeTicket,
    handle,
    stop: (): void => {
      if (sweeper !== null) {
        clearInterval(sweeper);
        sweeper = null;
      }
      tickets.clear();
    },
  };
};
