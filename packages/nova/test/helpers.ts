/**
 * Shared test helpers — single home for the async/payload/frame utilities that
 * were previously copy-pasted across the test suite (`waitFor`, payload
 * factories, frame parsers, ws-open helpers). Keeping them here means one
 * place to update for payload shape changes, new event schemas, or transport
 * layout changes.
 *
 * Requires: `bun run generate` + `cargo build --release` (indirectly, for the
 * FFI-backed encode paths used by `roundTrip`).
 */
import { expect } from "bun:test";
import { createServer, type IgnServer, type IgnServerOptions } from "../public/server";
import { decodeFrame, WIRE_HEADER_LEN } from "../src/generated/registry";
import type { EventName, Events } from "../src/schema";
import { encodeEvent } from "../src/transport/transport";

// ── async helpers ──────────────────────────────────────────────────────

/** Poll `fn` until it returns truthy, or throw after `timeout` ms. */
export async function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

/** Open a WebSocket (binaryType = "arraybuffer"), resolving once open. */
export function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("open failed"));
  });
}

/** True if the WebSocket upgrade succeeds (onopen fired), false otherwise. */
export function tryConnect(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, init as never);
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
    };
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
    setTimeout(() => done(false), 2000);
  });
}

/** Boot a server on an ephemeral port; returns the server + its ws url. */
export function bootServer(options: Omit<IgnServerOptions, "port"> = {}): {
  server: IgnServer;
  url: string;
} {
  const server = createServer({ port: 0, ...options });
  return { server, url: `ws://localhost:${server.port}/ws` };
}

// ── payload factories ──────────────────────────────────────────────────

export function quote(symbol = "AAPL", over: Partial<Events["quote"]> = {}): Events["quote"] {
  return { symbol, bid: 1, ask: 2, bidSize: 3, askSize: 4, ts: 5, ...over };
}

export function trade(over: Partial<Events["trade"]> = {}): Events["trade"] {
  return { symbol: "MSFT", price: 1, volume: 1, side: "buy", ts: 2, ...over };
}

export function portfolio(over: Partial<Events["portfolio"]> = {}): Events["portfolio"] {
  return {
    accountId: "acc-1",
    positions: [
      { symbol: "AAPL", quantity: 100, avgPrice: 175, pnl: 500.5 },
      { symbol: "MSFT", quantity: 50, avgPrice: 400, pnl: -120 },
    ],
    totalValue: 18000,
    cash: 2500,
    ts: 1720000000000,
    updatedBy: "ignex-test",
    ...over,
  };
}

export function order(over: Partial<Events["order"]> = {}): Events["order"] {
  return {
    orderId: "o",
    customer: { id: "c", name: "n", vip: true, loyaltyPoints: 1, rating: 1 },
    lines: [{ sku: "s", qty: 1, unitPrice: 1, tags: ["hot"] }],
    notes: ["n"],
    discounts: [0.1],
    active: true,
    createdAt: 1,
    ...over,
  };
}

export function complex(over: Partial<Events["complex"]> = {}): Events["complex"] {
  return {
    id: "c1",
    names: ["alpha", "βета"],
    prices: [1.5, -2.25],
    counts: [1, 1234567890123],
    flags: [true, false],
    tags: ["hot", "sale"],
    active: true,
    total: 99.5,
    ts: 5,
    ...over,
  };
}

export function bigVal(over: Partial<Events["bigVal"]> = {}): Events["bigVal"] {
  return { id: "b", seq: 9007199254740993n, when: 5, ...over };
}

/** A canonical valid payload for every event (baseline for tampering tests). */
export const payloads: Record<EventName, Events[EventName]> = {
  quote: quote(),
  trade: trade(),
  portfolio: portfolio(),
  complex: complex(),
  order: order(),
  bigVal: bigVal(),
};

// ── frame helpers ──────────────────────────────────────────────────────

/** LE u32 size prefix at the start of the flatbuffer payload region. */
export function sizePrefix(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset).getUint32(WIRE_HEADER_LEN, true);
}

/** LE u32 event id from the envelope header. */
export function frameId(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset).getUint32(1, true);
}

/** Naive byte-sequence search (no allocation). */
export function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0) return true;
  outer: for (let i = 0; i + needle.byteLength <= haystack.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Encode → decode and assert the event name, returning the plain payload. */
export function roundTrip<K extends keyof Events>(name: K, payload: Events[K]): Events[K] {
  const decoded = decodeFrame(encodeEvent(name, payload));
  if (!decoded) throw new Error(`roundTrip: decodeFrame returned null for "${String(name)}"`);
  expect(decoded.name).toBe(name);
  return decoded.payload as Events[K];
}

/** Decode a ws `message` event payload (ArrayBuffer) into a frame or null. */
export function decodeWsFrame(ev: MessageEvent): ReturnType<typeof decodeFrame> {
  return decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
}
