/**
 * Proxy / forwarding helpers.
 *
 * Design:
 * - Pure header sanitizers
 * - Pure request-init factory
 * - No global BodyInit dependency
 * - AbortSignal.timeout based cancellation
 */

import { stripHopByHopHeaders } from "./headers";

type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

type ProxyRequestInit = FetchRequestInit & {
  duplex?: "half";
};

/**
 * Options for {@link proxyRequest} / {@link forwardRequest}.
 *
 * Extends the fetch init shape (minus `body`, which is re-added for clarity)
 * with a `timeoutMs` that auto-aborts the upstream request.
 */
export interface ProxyOptions extends Omit<FetchRequestInit, "body"> {
  timeoutMs?: number;
  body?: FetchRequestInit["body"];
  /**
   * Forward the client's original `x-forwarded-for` / `x-forwarded-host` /
   * `x-forwarded-proto` headers upstream. Default `false`: a client-controlled
   * `x-forwarded-for` forwarded verbatim is a log/authz poisoning vector —
   * every downstream hop would trust an attacker-chosen "client IP". Only
   * enable this when the upstream expects an existing chain YOU control.
   */
  preserveForwardedHeaders?: boolean;
}

/**
 * Remove hop-by-hop headers and request-specific headers
 * that must be recomputed for upstream.
 */
const sanitizeRequestHeaders = (headers: Headers): Headers => {
  const out = stripHopByHopHeaders(headers);
  out.delete("host");
  return out;
};

/**
 * Remove hop-by-hop headers from upstream response.
 */
const sanitizeResponseHeaders = (headers: Headers): Headers => stripHopByHopHeaders(headers);

/**
 * Create a combined timeout + optional caller signal.
 *
 * Uses `AbortSignal.timeout`/`AbortSignal.any` where available (they propagate
 * to the response body stream too, so a slow-drip upstream is cut at the total
 * deadline); falls back to a manual timer + `AbortController` otherwise.
 */
const createProxySignal = (opts: ProxyOptions): AbortSignal => {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const caller = opts.signal;

  if (typeof AbortSignal.timeout === "function") {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!caller) return timeoutSignal;
    return typeof AbortSignal.any === "function"
      ? AbortSignal.any([caller, timeoutSignal])
      : timeoutSignal;
  }

  // Defensive fallback for runtimes without AbortSignal.timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Upstream timeout")), timeoutMs);
  if (caller) {
    const onAbort = (): void => {
      clearTimeout(timer);
      controller.abort();
    };
    if (caller.aborted) onAbort();
    else caller.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
};

/**
 * Type guard for stream-like bodies.
 */
const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  typeof value === "object" &&
  value !== null &&
  "pipeTo" in value &&
  typeof value.pipeTo === "function";

/**
 * Build fetch init for upstream request.
 */
const createProxyInit = (opts: ProxyOptions, signal: AbortSignal): ProxyRequestInit => {
  const headers = sanitizeRequestHeaders(
    opts.headers instanceof Headers ? opts.headers : new Headers(opts.headers),
  );

  const init: ProxyRequestInit = {
    method: opts.method ?? "GET",
    headers,
    redirect: opts.redirect ?? "manual",
    signal,
  };

  const body = opts.body;

  if (body != null) {
    init.body = body;

    if (isReadableStream(body)) {
      init.duplex = "half";
    }
  }

  return init;
};

const isTimeoutError = (err: unknown): boolean =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

const createGatewayTimeout = (): Response =>
  Response.json({ error: "Upstream timeout", status: 504 }, { status: 504 });

const createBadGateway = (): Response =>
  Response.json({ error: "Bad Gateway", status: 502 }, { status: 502 });

/**
 * Proxy a request to an upstream `target`, returning the upstream response
 * (auto-decompressed; hop-by-hop headers stripped; `x-proxy: ignex` added).
 *
 * Never throws: timeouts become a 504 and other upstream failures a 502.
 *
 * @param target - Upstream URL.
 * @param opts - Fetch init + optional `timeoutMs`.
 * @returns The upstream response, or a 502/504 error response.
 */
export async function proxyRequest(
  target: string | URL,
  opts: ProxyOptions = {},
): Promise<Response> {
  try {
    const signal = createProxySignal(opts);
    const init = createProxyInit(opts, signal);

    const upstream = await fetch(target.toString(), init);

    const responseHeaders = sanitizeResponseHeaders(upstream.headers);

    // `fetch` auto-decompresses the upstream body, so forwarding the original
    // content-encoding/content-length would describe a body we no longer have
    // (the client would fail to decompress it — Z_DATA_ERROR). Drop both when
    // the upstream was compressed.
    if (upstream.headers.get("content-encoding")) {
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    }

    responseHeaders.set("x-proxy", "ignex");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return createGatewayTimeout();
    }

    return createBadGateway();
  }
}

/**
 * Forward an incoming request to an upstream `target`, preserving method,
 * body, query string and hop-by-hop-sanitized headers.
 *
 * A malformed `target` is caught and returned as a 502 rather than throwing
 * a `TypeError` at the caller; upstream timeouts become a 504.
 *
 * @param req - The incoming request.
 * @param target - Upstream URL.
 * @param opts - Fetch init + optional `timeoutMs`.
 * @returns The upstream response, or a 502/504 error response.
 */
export async function forwardRequest(
  req: Request,
  target: string | URL,
  opts: ProxyOptions = {},
): Promise<Response> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(target.toString());
  } catch {
    return createBadGateway();
  }
  const incoming = new URL(req.url);

  if (!targetUrl.search) {
    targetUrl.search = incoming.search;
  }

  const headers = sanitizeRequestHeaders(req.headers);

  // The client is untrusted: strip its forwarded-* claims before the request
  // crosses the trust boundary (see ProxyOptions.preserveForwardedHeaders).
  if (!opts.preserveForwardedHeaders) {
    headers.delete("x-forwarded-for");
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-proto");
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body != null;

  const body = hasBody ? req.body : undefined;

  return proxyRequest(targetUrl, {
    ...opts,
    method: req.method,
    headers,
    ...(body ? { body } : {}),
  });
}
