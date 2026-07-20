/**
 * @fileoverview Proxy / forwarding helpers.
 * Streams upstream responses directly to the client.
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
];

export interface ProxyOptions extends Omit<RequestInit, "body"> {
  timeoutMs?: number;
  body?: BodyInit | ReadableStream | null;
}

function sanitizeRequestHeaders(headers: Headers): Headers {
  const out = new Headers(headers);

  for (const h of HOP_BY_HOP) out.delete(h);

  out.delete("host");
  out.delete("content-length");

  return out;
}

function sanitizeResponseHeaders(headers: Headers): Headers {
  const out = new Headers(headers);

  for (const h of HOP_BY_HOP) out.delete(h);

  return out;
}

export async function proxyRequest(
  target: string | URL,
  opts: ProxyOptions = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 10_000
  );

  try {
    const headers = sanitizeRequestHeaders(
      opts.headers instanceof Headers
        ? opts.headers
        : new Headers(opts.headers)
    );

    const init: any = {
      method: opts.method ?? "GET",
      headers,
      redirect: opts.redirect ?? "manual",
      signal: opts.signal ?? controller.signal,
    };

    if (opts.body != null) {
      init.body = opts.body;

      // Required by fetch implementations when streaming a request body.
      if (typeof (opts.body as any).pipeTo === "function") {
        init.duplex = "half";
      }
    }

    const upstream = await fetch(target.toString(), init as RequestInit);

    const responseHeaders = sanitizeResponseHeaders(upstream.headers);
    responseHeaders.set("x-proxy", "flux");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return Response.json(
        { error: "Upstream timeout", status: 504 },
        { status: 504 }
      );
    }

    return Response.json(
      { error: "Bad Gateway", status: 502 },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Forward the incoming request to another target.
 * Preserves method, query, headers, and streams request body.
 */
export async function forwardRequest(
  req: Request,
  target: string | URL,
  opts: ProxyOptions = {}
): Promise<Response> {
  const incoming = new URL(req.url);
  const targetUrl = new URL(target.toString());

  // Preserve query string unless target already has one.
  if (!targetUrl.search) {
    targetUrl.search = incoming.search;
  }

  const headers = sanitizeRequestHeaders(req.headers);

  const hasBody =
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.body != null;

  return proxyRequest(targetUrl, {
    ...opts,
    method: req.method,
    headers,
    body: hasBody ? (req.body as ReadableStream) : undefined,
  });
}