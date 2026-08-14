/**
 * @fileoverview Shared response-finalization helpers.
 *
 * Mirrors the compiler-generated `__withBody` / `jsonReply` / `textReply` /
 * `htmlReply` / `__finalize` helpers (see
 * `compiler/src/phases/codegen/helpers.ts` and `routes/handler.ts`). The
 * interpreted router (`http/router.ts`) reuses these so interpreted and
 * AOT-compiled routes finalize responses identically: one `TextEncoder` pass,
 * an exact `content-length` (so compression never buffers), and
 * serializer-aware status dispatch.
 */

/** A per-status serializer map (`"200"`, `"201"`, …, plus `default`). */
export interface StatusSerializerMap {
  readonly [status: string]: ((value: unknown) => unknown) | undefined;
  readonly default?: (value: unknown) => unknown;
}

/**
 * Build a `Response` from pre-encoded bytes with an exact `content-length`.
 *
 * Mirrors the compiled `__withBody`. The body is encoded by the caller (one
 * `TextEncoder` pass) and the real byte length is authoritative — Bun only
 * materializes `content-length` at serve time, so without this, middleware
 * (compression) must buffer every response just to learn its size. Emitting it
 * lets compression skip buffering small bodies.
 */
export const withBody = (bytes: Uint8Array | null, type: string, init?: ResponseInit): Response => {
  const h = new Headers({ "content-type": type });
  const ih = init && init.headers;
  if (ih) {
    if (
      ih instanceof Headers ||
      (typeof (ih as { forEach?: unknown }).forEach === "function" && !Array.isArray(ih))
    ) {
      (ih as Headers).forEach((value, key) => h.set(key, value));
    } else if (Array.isArray(ih)) {
      for (const [k, v] of ih) h.set(k, v);
    } else {
      for (const [k, v] of Object.entries(ih as Record<string, unknown>)) {
        if (v != null) h.set(k, String(v));
      }
    }
  }
  if (bytes !== null) h.set("content-length", String(bytes.byteLength));
  const { headers: _ignored, ...rest } = init ?? {};
  return new Response(bytes as BodyInit, { ...rest, headers: h });
};

/** Encode `data` as a JSON response (one `TextEncoder` pass, exact length). */
export const jsonReply = (data: unknown, init?: ResponseInit): Response => {
  const s = JSON.stringify(data);
  if (s === undefined) return withBody(null, "application/json; charset=utf-8", init);
  return withBody(new TextEncoder().encode(s), "application/json; charset=utf-8", init);
};

/** Encode `data` as a text/plain response. */
export const textReply = (data: unknown, init?: ResponseInit): Response =>
  withBody(new TextEncoder().encode(String(data)), "text/plain; charset=utf-8", init);

/** Encode `data` as a text/html response. */
export const htmlReply = (data: unknown, init?: ResponseInit): Response =>
  withBody(new TextEncoder().encode(String(data)), "text/html; charset=utf-8", init);

/**
 * Finalize a route-handler result into a `Response`.
 *
 * Mirrors the compiled `__finalize` semantics for ALL return forms:
 * `Response` → passthrough; `undefined`/`null` → 204; `{ status, body }` →
 * status-aware; any other value → serialized by `reply` (default `jsonReply`).
 *
 * NOTE: `set` is NOT applied here — the single outer `applySet` applies
 * headers/status/cookies exactly once. Applying set inside finalize AND again
 * in the route core fn caused duplicated `set-cookie` headers.
 */
export const finalizeResponse = (
  result: unknown,
  ctx: { readonly set?: { status?: number } } | undefined,
  serializers?: StatusSerializerMap,
  reply: (body: unknown, init?: ResponseInit) => Response = jsonReply,
): Response => {
  const set = ctx?.set;
  if (result instanceof Response) return result;
  if (result === undefined || result === null) {
    return new Response(null, { status: set?.status ?? 204 });
  }
  let status = set?.status;
  let body: unknown = result;
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "body" in result &&
    Number.isInteger((result as { status: unknown }).status)
  ) {
    status = status ?? (result as { status: number }).status;
    body = (result as { body: unknown }).body;
  }
  status = status ?? 200;
  const ser = serializers?.[String(status)] ?? serializers?.["200"] ?? serializers?.default;
  if (ser) {
    return withBody(
      new TextEncoder().encode(String(ser(body))),
      "application/json; charset=utf-8",
      { status },
    );
  }
  return reply(body, { status });
};
