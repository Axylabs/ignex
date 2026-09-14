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

import { textByteLength } from "./body/size";

const CTL_TEST = /[\r\n\0]/;
const CTL_STRIP = /[\r\n\0]/g;

/**
 * Strip CR/LF/NUL from a header value before it is written to the wire.
 *
 * Reflected user input (query/body values echoed into headers) must never be
 * able to smuggle a second header nor crash the whole request: the runtime
 * rejects invalid header values (`Headers.set` throws on CR/LF/NUL), which
 * turns a hostile `?v=foo%0d%0ax-injected: pwned` into a 500. Dropping the
 * control characters instead keeps the request healthy (200) while the
 * injection never reaches the wire. Matches Elysia's CRLF-drop behavior.
 *
 * The regex only runs when a control char is actually present — the hot path
 * (well-formed values) skips it entirely.
 *
 * Lives here (not in `headers.ts`) because that module already imports from
 * this one; keeping the helper here avoids an import cycle.
 */
export const sanitizeHeaderValue = (value: string): string =>
  CTL_TEST.test(value) ? value.replace(CTL_STRIP, "") : value;

/** A per-status serializer map (`"200"`, `"201"`, …, plus `default`). */
export interface StatusSerializerMap {
  readonly [status: string]: ((value: unknown) => unknown) | undefined;
  readonly default?: (value: unknown) => unknown;
}

/**
 * Responses that were built with the app's static response defaults already
 * merged in (see `withBody`'s `defaults` parameter).
 *
 * Plugins that decorate every response (notably `security()`) consult this to
 * skip re-applying header sets that were baked in at construction: a
 * `WeakSet` probe is far cheaper than the 8 native `Headers.set` calls a
 * post-hoc mutation costs, and it is exact — a response built anywhere else
 * (a raw `Response` passthrough) is correctly NOT skipped.
 */
const decoratedResponses = new WeakSet<Response>();

/** Whether `response` already carries the app's static response defaults. */
export const isDecoratedResponse = (response: Response): boolean =>
  decoratedResponses.has(response);

/**
 * Register a response as already carrying the app's static response defaults.
 *
 * Exported for the compiler-generated `__withBody`, which builds its header
 * record from the emitted `__DEFAULT_HEADERS` constant rather than calling
 * {@link withBody}. Both paths register through the SAME registry here so a
 * decorating plugin's skip check is uniform.
 */
export const markDecoratedResponse = (response: Response): void => {
  decoratedResponses.add(response);
};

/**
 * Build a `Response` from pre-encoded bytes with an exact `content-length`.
 *
 * Mirrors the compiled `__withBody`. The body is encoded by the caller (one
 * `TextEncoder` pass) and the real byte length is authoritative — Bun only
 * materializes `content-length` at serve time, so without this, middleware
 * (compression) must buffer every response just to learn its size. Emitting it
 * lets compression skip buffering small bodies.
 *
 * `defaults` are app-invariant response headers (baked plugin output such as
 * the `security()` header set) applied at CONSTRUCTION rather than by
 * mutating the finished `Response`. Building them into the same header record
 * means Bun materializes the header block once, instead of the ~8 native
 * `Headers.set` round-trips a per-request plugin mutation costs. Responses
 * built this way are registered in `decoratedResponses` so decorating plugins
 * can skip them.
 */
/**
 * Merge a supported header shape (`Headers` / entries array / plain object)
 * into a target `Headers` instance.
 *
 * Exported because `http/headers.ts` reuses it (`mergeHeaders`); that module
 * already imports `withBody` from here, so hosting it here keeps the
 * dependency one-way instead of creating a cycle.
 */
export const applyInitHeaders = (target: Headers, init: unknown): void => {
  if (!init) return;

  if (
    init instanceof Headers ||
    (typeof (init as { forEach?: unknown }).forEach === "function" && !Array.isArray(init))
  ) {
    (init as Headers).forEach((value, key) => {
      target.set(key, value);
    });
    return;
  }

  if (Array.isArray(init)) {
    for (const [k, v] of init as Array<[string, string | undefined]>) {
      if (v !== undefined) target.set(k, v);
    }
    return;
  }

  for (const [k, v] of Object.entries(init as Record<string, string | undefined>)) {
    if (v != null) target.set(k, String(v));
  }
};

/**
 * Apply the request's accumulated `ctx.set.headers` onto a `Headers`, one
 * `set` at a time.
 *
 * Incremental `set()` is measurably cheaper per header than letting Bun
 * populate from a bulk plain-object init (~56 vs ~84 ns/header on Bun 1.4.2 —
 * see `withBody`), so the reply path builds its small base record and adds the
 * large sets this way.
 *
 * Every value is sanitized (these can be request-derived) and array-valued
 * entries are skipped: they need `append` semantics, which only `applySet` can
 * express (and `consumeSetHeaders` carries them forward to it).
 *
 * @param target - The `Headers` to mutate (in place).
 * @param record - Header name → value pairs to apply.
 */
const applySetHeaderRecord = (target: Headers, record: Record<string, string>): void => {
  for (const k in record) {
    if (!Object.hasOwn(record, k)) continue;
    const v = record[k] as string | string[] | undefined | null;
    if (v == null || Array.isArray(v)) continue;

    target.set(k, sanitizeHeaderValue(String(v)));
  }
};

/**
 * Apply an app-invariant header record to a fresh `Headers`.
 *
 * `record` MUST be a boot-time frozen constant whose values were sanitized
 * once when it was built (see `collectResponseDefaults`, and the compiler's
 * `__DEFAULT_HEADERS`) — which is exactly why this skips the `Object.hasOwn`
 * guard and `sanitizeHeaderValue` that `applySetHeaderRecord` needs for
 * request-derived values. Paying those per request costs ~18 ns/header, i.e.
 * ~250 ns on a 14-header response (measured on Bun 1.4.2, 300k iterations,
 * body read included):
 *
 *   for..in + set()                       70.8 ns/header
 *   for..in + hasOwn + sanitize + set()   88.4 ns/header
 *
 * @param target - The `Headers` to mutate (in place).
 * @param record - Frozen, pre-sanitized header name → value pairs.
 */
const applyStaticHeaders = (target: Headers, record: Record<string, string>): void => {
  for (const k in record) target.set(k, record[k] as string);
};

/**
 * Build a `Response` with an exact `content-length`.
 *
 * Mirrors the compiled `__withBody`. The body is NOT pre-encoded by the
 * caller: `new Response(string)` is measurably cheaper than
 * `new Response(TextEncoder.encode(string))` because Bun encodes internally
 * and can hand the string straight to the socket. The real byte length is
 * still authoritative — Bun only materializes `content-length` at serve time,
 * so without it middleware (compression) must buffer every response just to
 * learn its size. Emitting it lets compression skip buffering small bodies.
 *
 * `defaults` are app-invariant response headers (baked plugin output such as
 * the `security()` header set) and `setHeaders` is the request's accumulated
 * `ctx.set.headers`. Both are applied INCREMENTALLY via `Headers.set` after
 * construction rather than as a bulk plain-object header init, because Bun's
 * bulk path is measurably more expensive per header (measured on Bun 1.4.2,
 * 14 headers, 200k iterations):
 *
 *   new Headers(<14-key object>)    1268 ns   (84.2 ns/header)
 *   new Headers() + 14x set()        877 ns   (56.3 ns/header)
 *
 * i.e. bulk object init is ~45% slower than incremental `set()`. The same
 * holds for `Response`'s `init.headers`. `defaults` is further applied by
 * `applyStaticHeaders` (no `hasOwn`/sanitize) since it is a frozen boot-time
 * constant — see that helper. Responses built with `defaults` are registered
 * in `decoratedResponses` so decorating plugins can skip them.
 *
 * @param payload - The body: a string (Bun encodes it internally — the
 * preferred path) or pre-encoded bytes, or `null` for an empty body.
 * @param type - Value for the `content-type` header.
 * @param init - Optional `ResponseInit` (status/headers) for the response.
 * @param defaults - App-invariant headers baked in at construction.
 * @param setHeaders - The request's accumulated `ctx.set.headers`.
 * @returns The constructed `Response`.
 */
export const withBody = (
  payload: Uint8Array | string | null,
  type: string,
  init?: ResponseInit,
  defaults?: Record<string, string> | null,
  setHeaders?: Record<string, string> | null,
): Response => {
  const ih = init?.headers;
  // Fast path: no init headers — plain-object headers (no `Headers` alloc),
  // and no rest/spread when init is undefined (the common `ctx.json(data)`).
  const h: Record<string, string> = { "content-type": type };
  if (payload !== null) {
    // `textByteLength` uses native `Buffer.byteLength`, which computes the
    // UTF-8 length WITHOUT materializing the array (see `http/body/size.ts`).
    h["content-length"] = String(
      typeof payload === "string" ? textByteLength(payload) : payload.byteLength,
    );
  }

  const body = payload as BodyInit;
  let response: Response;

  if (!ih) {
    if (init === undefined) {
      response = new Response(body, { headers: h });
    } else {
      const { headers: _ignored, ...rest } = init;
      response = new Response(body, { ...rest, headers: h });
    }

    // Add the (potentially large) header sets INCREMENTALLY — see the note
    // above: Bun's bulk plain-object header init costs ~84 ns/header against
    // ~56 ns/header for `Headers.set`, so a 14-header response is cheaper built
    // as 2 headers + 12 sets. Array-valued headers are skipped here and left to
    // `applySet`, which alone can express `append` semantics.
    //
    // Re-tested at SERVER level (workload-free /health, 4 interleaved rounds):
    // merging the defaults into the construction record instead measured SLOWER
    // (17.06us vs 16.60us) — the per-request ~10-key spread outweighs the cost
    // of the extra `set` calls. Do not "optimise" this back to a merge without
    // re-measuring on a served server.
    if (defaults) applyStaticHeaders(response.headers, defaults);
    if (setHeaders) applySetHeaderRecord(response.headers, setHeaders);
  } else {
    const hh = new Headers(h);
    if (defaults) applyStaticHeaders(hh, defaults);
    if (setHeaders) applySetHeaderRecord(hh, setHeaders);
    applyInitHeaders(hh, ih);
    response = new Response(body, { ...init, headers: hh });
  }

  if (defaults) decoratedResponses.add(response);
  return response;
};

/** Encode `data` as a JSON response (one `Buffer.byteLength` pass, exact length). */
export const jsonReply = (data: unknown, init?: ResponseInit): Response => {
  const s = JSON.stringify(data);
  if (s === undefined) return withBody(null, "application/json; charset=utf-8", init);
  return withBody(s, "application/json; charset=utf-8", init);
};

/** Encode `data` as a text/plain response. */
export const textReply = (data: unknown, init?: ResponseInit): Response =>
  withBody(String(data), "text/plain; charset=utf-8", init);

/** Encode `data` as a text/html response. */
export const htmlReply = (data: unknown, init?: ResponseInit): Response =>
  withBody(String(data), "text/html; charset=utf-8", init);

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
    return withBody(String(ser(body)), "application/json; charset=utf-8", {
      status,
    });
  }
  return reply(body, status === 200 ? undefined : { status });
};
