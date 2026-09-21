/**
 * @fileoverview Ignex Server Integration - serve/stop lifecycle management
 *
 * This module handles the `Bun.serve` integration, boot configuration,
 * and app shutdown lifecycle. It provides the `serve()` and `stop()`
 * methods on the app instance and manages server lifecycle hooks.
 */

import { DEFAULT_SERVER_IDLE_TIMEOUT } from "../http/tls";

/**
 * Default per-request body ceiling (bytes) applied by `serve()` when the app
 * does not configure `maxRequestBodySize`. 64MB comfortably covers the
 * framework's default 20MB single-file upload limit while capping the memory
 * an adversarial chunked request can pin per connection.
 */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 64 * 1024 * 1024;

/**
 * Default WebSocket frame ceiling (bytes) injected when an app configures a
 * `websocket` handler without its own `maxPayloadLength`. Bun's implicit
 * default is far larger than typical message workloads need.
 */
export const DEFAULT_WS_MAX_PAYLOAD_LENGTH = 4 * 1024 * 1024;

/**
 * Resolve Bun.serve transport limits from raw serve options (pure, non-
 * mutating): explicit server-level idle timeout with Bun's documented HTTP
 * default as fallback; deliberate body ceiling instead of silently inheriting
 * Bun's larger default; and a WS frame ceiling injected (via a copy) when an
 * app configured a `websocket` handler without `maxPayloadLength`.
 */
export const resolveServeLimits = (opts: {
  idleTimeout?: unknown;
  maxRequestBodySize?: unknown;
  websocket?: unknown;
}): {
  idleTimeout: number;
  maxRequestBodySize: number;
  websocket: unknown;
} => {
  let websocket = opts.websocket;
  if (websocket != null && typeof websocket === "object") {
    const ws = websocket as Record<string, unknown>;
    if (ws.maxPayloadLength === undefined) {
      websocket = { maxPayloadLength: DEFAULT_WS_MAX_PAYLOAD_LENGTH, ...ws };
    }
  }
  return {
    idleTimeout: (opts.idleTimeout as number | undefined) ?? DEFAULT_SERVER_IDLE_TIMEOUT,
    maxRequestBodySize:
      (opts.maxRequestBodySize as number | undefined) ?? DEFAULT_MAX_REQUEST_BODY_SIZE,
    websocket,
  };
};
