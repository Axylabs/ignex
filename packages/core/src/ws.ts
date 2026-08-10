/**
 * @fileoverview WebSocket support with typed messages and topics.
 */

import { wsAcceptKey } from "@flux/native";
import type { FluxContext } from "./context";
import type { ServerWebSocket, WebSocketHandler } from "./types";

/** Compute the RFC 6455 Sec-WebSocket-Accept value (native-accelerated). */
export const acceptWsKey = (key: string): string => wsAcceptKey(key);

export class FluxWS<Context = unknown, Body = unknown, Response = unknown> {
  constructor(
    public raw: ServerWebSocket<Context>,
    public data: Context,
    public body: Body,
  ) {}

  send(data: Response | string | ArrayBuffer | Uint8Array, compress?: boolean): number {
    // Pass strings / binary through verbatim; JSON-stringify any other object.
    // `Response` is a generic type parameter, so `typeof`/`instanceof` cannot
    // narrow it away — the cast reflects that this branch is binary/string.
    if (typeof data !== "object" || data instanceof ArrayBuffer || data instanceof Uint8Array) {
      return this.raw.send(data as string | ArrayBuffer | Uint8Array, compress);
    }
    return this.raw.send(JSON.stringify(data), compress);
  }

  sendText(data: string, compress?: boolean): number {
    return this.raw.sendText(data, compress);
  }
  sendBinary(data: ArrayBuffer | Uint8Array, compress?: boolean): number {
    return this.raw.sendBinary(data, compress);
  }
  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }
  terminate(): void {
    this.raw.terminate();
  }
  ping(data?: string | ArrayBuffer): number {
    return this.raw.ping(data);
  }
  pong(data?: string | ArrayBuffer): number {
    return this.raw.pong(data);
  }

  publish(topic: string, data: Response | string | ArrayBuffer, compress?: boolean): number {
    // Pass strings / binary through verbatim; JSON-stringify any other object.
    // `Response` is a generic type parameter — see `send`.
    if (typeof data !== "object" || data instanceof ArrayBuffer) {
      return this.raw.publish(topic, data as string | ArrayBuffer, compress);
    }
    return this.raw.publish(topic, JSON.stringify(data), compress);
  }

  subscribe(topic: string): void {
    this.raw.subscribe(topic);
  }
  unsubscribe(topic: string): void {
    this.raw.unsubscribe(topic);
  }
  isSubscribed(topic: string): boolean {
    return this.raw.isSubscribed(topic);
  }
  cork<T>(cb: (ws: FluxWS<Context, Body, Response>) => T): T {
    return this.raw.cork(() => cb(this));
  }

  get remoteAddress(): string {
    return this.raw.remoteAddress;
  }
  get readyState(): number {
    return this.raw.readyState;
  }
  get subscriptions(): string[] {
    return this.raw.subscriptions;
  }
}

export interface WSLocalHook<Context = unknown, Body = unknown, Response = unknown> {
  open?(ws: FluxWS<Context, Body, Response>): void | Promise<void>;
  message?(ws: FluxWS<Context, Body, Response>, message: Body): void | Promise<void>;
  drain?(ws: FluxWS<Context, Body, Response>): void | Promise<void>;
  close?(ws: FluxWS<Context, Body, Response>, code: number, reason: string): void | Promise<void>;
  upgrade?: Record<string, unknown> | ((ctx: FluxContext) => unknown);
  body?: Body;
  response?: Response;
}

export const createWSHandler = <Context, Body, Response>(
  hook: WSLocalHook<Context, Body, Response>,
): WebSocketHandler<Context> => ({
  open(ws) {
    hook.open?.(new FluxWS(ws, ws.data, undefined as Body));
  },

  message(ws, message) {
    let parsed: unknown = message;

    if (typeof message === "string") {
      try {
        parsed = JSON.parse(message);
      } catch {
        // keep as string
      }
    }

    hook.message?.(new FluxWS(ws, ws.data, parsed as Body), parsed as Body);
  },

  drain(ws) {
    hook.drain?.(new FluxWS(ws, ws.data, undefined as Body));
  },

  close(ws, code, reason) {
    hook.close?.(new FluxWS(ws, ws.data, undefined as Body), code, reason);
  },
});
