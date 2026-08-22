/**
 * Upgrade gate — pure-ish decision logic for who may open a WebSocket:
 * connection limit → origin allowlist → bearer token → custom `authenticate`.
 * Returns a `Response` to reject the upgrade, or `undefined` to allow it
 * (after calling `srv.upgrade`). Mirrors the former `IgnServer.tryUpgrade`.
 *
 * `authenticate` may return a `ClientMeta` (`{id, groups, meta}`) to pin the
 * client's identity for targeted sends / grouping; otherwise a UUID is
 * auto-assigned. A duplicate explicit id rejects the new connection (409).
 */
import type { ClientMeta, ServerState, WsData } from "./state";

export async function checkUpgrade(
  state: ServerState,
  req: Request,
  srv: ReturnType<typeof Bun.serve<WsData>>,
): Promise<Response | undefined> {
  if (state.maxConnections !== undefined && state.sockets.size >= state.maxConnections) {
    return new Response("too many connections", { status: 503 });
  }
  if (state.allowedOrigins) {
    const origin = req.headers.get("origin") ?? "";
    if (!state.allowedOrigins.includes(origin)) {
      return new Response("origin not allowed", { status: 403 });
    }
  }
  if (state.token) {
    const auth = req.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const ok = typeof state.token === "function" ? state.token(bearer) : bearer === state.token;
    if (!ok) return new Response("unauthorized", { status: 401 });
  }
  let authMeta: ClientMeta | undefined;
  if (state.authenticate) {
    const res = await state.authenticate(req);
    if (!res) return new Response("unauthorized", { status: 401 });
    if (typeof res === "object") authMeta = res;
  }
  // identity: explicit id from auth, else a fresh UUID. Duplicate ids are
  // rejected up-front (an admin can `disconnectClient` the stale session).
  const id = authMeta?.id ?? crypto.randomUUID();
  if (state.clients.has(id)) {
    return new Response("client id already in use", { status: 409 });
  }
  const data: WsData = {
    lastSeq: 0,
    topics: new Set(),
    groups: new Set(authMeta?.groups ?? []),
    id,
    ...(authMeta?.userId !== undefined ? { userId: authMeta.userId } : {}),
    ...(authMeta?.meta !== undefined ? { meta: authMeta.meta } : {}),
    connectedAt: Date.now(),
  };
  // bun-types requires the WebSocketData options arg when Data != undefined
  if (srv.upgrade(req, { data })) return undefined;
  return new Response("upgrade failed", { status: 400 });
}
