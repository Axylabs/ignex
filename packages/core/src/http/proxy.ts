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

export interface ProxyOptions extends Omit<FetchRequestInit, "body"> {
  timeoutMs?: number;
  body?: FetchRequestInit["body"];
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

    responseHeaders.set("x-proxy", "ignus");

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

export async function forwardRequest(
  req: Request,
  target: string | URL,
  opts: ProxyOptions = {},
): Promise<Response> {
  const incoming = new URL(req.url);
  const targetUrl = new URL(target.toString());

  if (!targetUrl.search) {
    targetUrl.search = incoming.search;
  }

  const headers = sanitizeRequestHeaders(req.headers);

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body != null;

  const body = hasBody ? req.body : undefined;

  return proxyRequest(targetUrl, {
    ...opts,
    method: req.method,
    headers,
    ...(body ? { body } : {}),
  });
}
