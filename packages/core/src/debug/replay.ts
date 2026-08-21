/**
 * @fileoverview Debugbar request replay — re-issue a stored request through
 * the live server (loopback), an explicit dispatcher, or a server handle.
 *
 * Split from the `debugbar()` plugin so the replay machinery is independently
 * testable and the plugin stays a thin composition.
 */

import type { IgnexContext } from "../http/context";
import { json, readBodyPreview } from "./respond";
import type { RequestTrace } from "./types";

/** Hop-by-hop headers must never be replayed (fetch recomputes them). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
  "host",
]);

/** Resolve a Bun server's own base URL (string | URL | {href}). */
export const serverBaseUrl = (server: unknown): string | null => {
  const url = (server as { url?: string | URL | { href?: string } } | null)?.url;
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return typeof url?.href === "string" ? url.href : null;
};

/**
 * Dispatch a replay request: explicit dispatcher → loopback → server handle.
 *
 * @param trace - The stored trace being replayed.
 * @param init - The reconstructed `RequestInit` (method/headers/body).
 * @param server - The live server handle (for loopback / handle dispatch).
 * @param dispatch - Optional explicit dispatcher (e.g. `(req) => app.handler(req)`).
 */
const dispatchReplay = async (
  trace: RequestTrace,
  init: RequestInit,
  server: { url?: string; fetch?(req: Request): Promise<Response> } | null,
  dispatch?: (req: Request) => Promise<Response>,
): Promise<Response> => {
  if (dispatch) {
    // Explicit dispatcher (e.g. `(req) => app.handler(req)`): same process,
    // full pipeline, no network round-trip.
    return dispatch(new Request(trace.request.url, init));
  }
  const base = serverBaseUrl(server);
  if (base) {
    // Real Bun server: loopback through the live HTTP stack so the NATIVE
    // route table (not just the fallback handler) matches the request.
    // Permissive TLS accepts the auto-generated dev certs.
    const captured = new URL(trace.request.url);
    const target = `${base.replace(/\/$/, "")}${captured.pathname}${captured.search}`;
    return fetch(target, { ...init, tls: { rejectUnauthorized: false } });
  }
  if (server && typeof server.fetch === "function") {
    // Non-Bun runtime / injected test server: dispatch through the handle.
    return server.fetch(new Request(trace.request.url, init));
  }
  return fetch(trace.request.url, init);
};

/**
 * Replay a stored request from the trace store.
 *
 * @param store - The trace store holding the captured request.
 * @param id - The trace id to replay.
 * @param ctx - The current request context (carries the live server handle).
 * @param dispatch - Optional explicit dispatcher (see {@link dispatchReplay}).
 * @returns A JSON response describing the replay outcome.
 */
export const replayRequest = async (
  store: { get(id: string): RequestTrace | undefined },
  id: string,
  ctx: IgnexContext,
  dispatch?: (req: Request) => Promise<Response>,
): Promise<Response> => {
  const trace = store.get(id);
  if (!trace) return json({ error: "not_found", status: 404 }, 404);
  const server = ctx.server as unknown as {
    url?: string;
    fetch?(req: Request): Promise<Response>;
  } | null;
  try {
    const body = trace.request.body ?? null;
    const headers = new Headers();
    for (const [key, value] of Object.entries(trace.request.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
    }
    const start = performance.now();
    const init: RequestInit = { method: trace.request.method, headers, body };
    const res = await dispatchReplay(trace, init, server, dispatch);
    const durationMs = performance.now() - start;
    const preview = await readBodyPreview(res, 64 * 1024);
    return json({
      ok: true,
      status: res.status,
      durationMs: Math.round(durationMs * 1000) / 1000,
      requestId: res.headers.get("x-request-id") ?? null,
      headers: Object.fromEntries(res.headers.entries()),
      body: preview,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
};
