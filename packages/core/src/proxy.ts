/**
 * Proxy / forwarding helpers.
 *
 * Design:
 * - Pure header sanitizers
 * - Pure request-init factory
 * - No global BodyInit dependency
 * - AbortSignal.timeout based cancellation
 */

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

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
  const out = new Headers(headers);

  for (const h of HOP_BY_HOP) out.delete(h);

  out.delete("host");
  out.delete("content-length");

  return out;
};

/**
 * Remove hop-by-hop headers from upstream response.
 */
const sanitizeResponseHeaders = (headers: Headers): Headers => {
  const out = new Headers(headers);

  for (const h of HOP_BY_HOP) out.delete(h);

  return out;
};

/**
 * Create a combined timeout + optional caller signal.
 */
const createProxySignal = (opts: ProxyOptions): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);

  if (!opts.signal) return timeoutSignal;

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([opts.signal, timeoutSignal]);
  }

  return timeoutSignal;
};

/**
 * Type guard for stream-like bodies.
 */
const isReadableStream = (
  value: unknown,
): value is ReadableStream<Uint8Array> =>
  typeof value === "object" &&
  value !== null &&
  "pipeTo" in value &&
  typeof value.pipeTo === "function";

/**
 * Build fetch init for upstream request.
 */
const createProxyInit = (
  opts: ProxyOptions,
  signal: AbortSignal,
): ProxyRequestInit => {
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
  err instanceof Error &&
  (err.name === "TimeoutError" || err.name === "AbortError");

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
    responseHeaders.set("x-proxy", "flux");

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

  const hasBody =
    req.method !== "GET" && req.method !== "HEAD" && req.body != null;

  const body = hasBody ? req.body : undefined;

  return proxyRequest(targetUrl, {
    ...opts,
    method: req.method,
    headers,
    ...(body ? { body } : {}),
  });
}