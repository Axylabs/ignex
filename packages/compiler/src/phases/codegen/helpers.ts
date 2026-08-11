/**
 * @fileoverview Codegen: generated runtime helper registry.
 *
 * Dependency-aware pruning of generated boilerplate. `deps` lists other
 * generated helpers a helper references; `core` lists `@ignus/core` symbols a
 * helper needs. Only helpers (and their transitive deps/core imports) that are
 * actually referenced end up in the output.
 */

import type { Emitter } from "../../emitter";

export interface HelperDef {
  readonly deps: readonly string[];
  readonly core: readonly string[];
}

export const HELPERS: Record<string, HelperDef> = {
  jsonReply: { deps: [], core: [] },
  textReply: { deps: [], core: [] },
  htmlReply: { deps: [], core: [] },
  streamReply: { deps: [], core: [] },
  emptyReply: { deps: [], core: [] },
  redirectReply: { deps: [], core: [] },
  statusReply: { deps: [], core: [] },
  validationError: { deps: [], core: ["ValidationError"] },
  __applySet: { deps: [], core: ["applySet"] },
  __finalize: { deps: [], core: [] },
  __handleError: {
    deps: ["__applySet"],
    core: ["errorToResponse", "runHooks"],
  },
  __schemaFor: { deps: [], core: [] },
  __validatePart: { deps: [], core: ["validateAsync"] },
  __extractParams: { deps: [], core: [] },
  __extractServer: { deps: [], core: [] },
  __wrap: {
    deps: ["__extractParams", "__extractServer", "__handleError"],
    core: ["createContext"],
  },
  __head: { deps: ["__wrap"], core: [] },
  __optionsHandler: {
    deps: ["__wrap", "__allowFor", "__applySet"],
    core: ["createContext", "runHooks"],
  },
  __allowFor: { deps: [], core: [] },
  __fallback: {
    deps: ["__wrap", "__optionsHandler", "__allowFor", "__applySet"],
    core: ["createContext", "runHooks", "applySet"],
  },
};

/** Transitive closure of generated helpers that must be emitted. */
export const resolveUsedHelpers = (e: Emitter): ReadonlySet<string> => {
  const used = new Set<string>();

  const visit = (name: string): void => {
    if (used.has(name)) return;
    used.add(name);
    for (const dep of HELPERS[name]?.deps ?? []) visit(dep);
  };

  for (const name of Object.keys(HELPERS)) {
    if (e.isUsed(name)) visit(name);
  }

  return used;
};

/**
 * Source of each generated runtime helper. Helpers are emitted only when the
 * closure of {@link resolveUsedHelpers} includes them.
 */
export const HELPER_SOURCES: Record<string, string> = {
  jsonReply: `const jsonReply = (data, init) => Response.json(data, init);`,
  textReply: `const textReply = (data, init) =>
  new Response(
    String(data),
    init
      ? { ...init, headers: { "content-type": "text/plain; charset=utf-8", ...init.headers } }
      : { headers: { "content-type": "text/plain; charset=utf-8" } }
  );`,
  htmlReply: `const htmlReply = (data, init) =>
  new Response(
    String(data),
    init
      ? { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } }
      : { headers: { "content-type": "text/html; charset=utf-8" } }
  );`,
  streamReply: `const streamReply = (stream, init) => new Response(stream, init);`,
  emptyReply: `const emptyReply = (status = 204) => new Response(null, { status });`,
  redirectReply: `const redirectReply = (url, status = 302) => Response.redirect(url, status);`,
  statusReply: `const statusReply = (code) => new Response(null, { status: code });`,
  validationError: `const validationError = (errors, on) =>
  new ValidationError("Validation failed", errors, on);`,
  __applySet: `const __applySet = (response, set, requestId) => applySet(response, set, requestId, __TRACE);`,
  __finalize: `const __finalize = (result, ctx, serializers, reply) => {
  // NOTE: set is NOT applied here — the single outer __applySet applies
  // headers/status/cookies exactly once. Applying set inside __finalize AND
  // again in the route core fn caused duplicated set-cookie headers.
  const set = ctx?.set;
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: set?.status ?? 204 });
  let status = set?.status;
  let body = result;
  if (typeof result === "object" && result !== null && "status" in result && "body" in result && Number.isInteger(result.status)) {
    status = status ?? result.status;
    body = result.body;
  }
  status = status ?? 200;
  const ser = serializers?.[String(status)] ?? serializers?.["200"] ?? serializers?.default;
  if (ser) return new Response(ser(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  return reply(body, { status });
};`,
  __handleError: `async function __handleError(err, ctx) {
  try {
    const r = await runHooks(__lc.error, ctx, err);
    if (r.response) return __applySet(r.response, r.ctx?.set ?? ctx?.set);
  } catch {
    // An error-stage hook that throws must not mask the original error.
  }
  return errorToResponse(err, EXPOSE_ERRORS);
}`,
  __schemaFor: `const __schemaFor = (m) => m?.schema ?? m?.default?.schema ?? undefined;`,
  __validatePart: `async function __validatePart(schemaPart, input, on) {
  if (schemaPart !== undefined && schemaPart !== null) {
    await validateAsync(schemaPart, input, on);
  }
}`,
  __extractParams: `function __extractParams(req, a, b) {
  if (req && typeof req === "object" && "params" in req && req.params) {
    return req.params;
  }

  const isServerLike = (x) =>
    x && typeof x === "object" && ("requestIP" in x || "fetch" in x || "stop" in x);

  if (a && typeof a === "object" && !isServerLike(a)) return a;
  if (b && typeof b === "object" && !isServerLike(b)) return b;

  return EMPTY_PARAMS;
}`,
  __extractServer: `function __extractServer(a, b) {
  const isServerLike = (x) =>
    x && typeof x === "object" && ("requestIP" in x || "fetch" in x || "stop" in x);

  if (isServerLike(a)) return a;
  if (isServerLike(b)) return b;
  return undefined;
}`,
  __wrap: `function __wrap(handler, wildcards = [], prefix) {
  return async function (req, a, b) {
    let params = __extractParams(req, a, b);

    if (wildcards.length) {
      let capture = params && params["*"];

      // Bun does not expose wildcard captures in req.params on some versions
      // (verified on Bun 1.4); derive the captured suffix from the URL by
      // stripping the route's static prefix when it is known.
      if (capture == null && prefix) {
        try {
          const pathname = new URL(req.url).pathname;
          if (pathname.startsWith(prefix)) {
            capture = decodeURIComponent(pathname.slice(prefix.length));
          }
        } catch {
          // leave capture undefined — no wildcard value is available
        }
      }

      if (capture != null) {
        const extra = {};
        for (const name of wildcards) extra[name] = capture;
        params = { ...(params ?? {}), ...extra };
      }
    }

    const server = __extractServer(a, b);

    try {
      return await handler(req, params ?? EMPTY_PARAMS, server);
    } catch (err) {
      const ctx = createContext(req, params ?? EMPTY_PARAMS, { body: BODY_LIMITS });
      ctx.server = server;
      return __handleError(err, ctx);
    }
  };
}`,
  __head: `function __head(handler, wildcards = [], prefix) {
  const wrapped = __wrap(handler, wildcards, prefix);

  return async function (req, a, b) {
    const res = await wrapped(req, a, b);
    const headers = new Headers(res.headers);
    headers.delete("content-length");

    return new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}`,
  __optionsHandler: `async function __optionsHandler(req, params, server) {
  const url = new URL(req.url);
  const allow = __allowFor(url.pathname) ?? "OPTIONS";

  const ctx = createContext(req, params ?? EMPTY_PARAMS, { body: BODY_LIMITS });
  ctx.server = server;

  // Run the full pre-handler chain so plugins/hooks apply to preflight too.
  const pre = await runHooks(__preStages, ctx);
  let response = pre.response ?? new Response(null, { status: 204 });
  response = __applySet(response, pre.ctx.set, pre.ctx.requestId);

  const headers = new Headers(response.headers);
  if (!headers.has("access-control-allow-methods")) {
    headers.set("Allow", allow);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}`,
  __allowFor: `function __allowFor(pathname) {
  const exact = __allowedStatic[pathname];
  if (exact) return exact;
  for (const entry of __allowedDynamic) {
    if (entry.re.test(pathname)) return entry.allow;
  }
  return undefined;
}`,
  __fallback: `async function __fallback(req, server) {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return __wrap(__optionsHandler, [])(req, undefined, server);
  }

  const allow = __allowFor(url.pathname);
  const status = allow ? 405 : 404;
  const code = allow ? "METHOD_NOT_ALLOWED" : "NOT_FOUND";
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (allow) headers.Allow = allow;

  let response = new Response(
    JSON.stringify({ error: allow ? "Method Not Allowed" : "Not Found", status, code }),
    { status, headers },
  );

  // Run the lifecycle so plugins/hooks (e.g. CORS, security headers) apply to
  // 404/405 responses too — matching interpreted behavior.
  if (__hasPreStages || __hasPostStages || __hasAfterResponse) {
    const ctx = createContext(req, EMPTY_PARAMS, { body: BODY_LIMITS });
    ctx.server = server;

    const pre = await runHooks(__preStages, ctx);
    if (pre.response) return __applySet(pre.response, pre.ctx.set, pre.ctx.requestId);

    const post = await runHooks(__postStages, pre.ctx, response);
    response = post.response ?? response;
    await runHooks(__lc.afterResponse ?? [], pre.ctx, response);
    response = __applySet(response, pre.ctx.set, pre.ctx.requestId);
  }

  return response;
}`,
};

/** Indent every non-empty line of a multi-line code block by two spaces. */
export const indentBody = (body: string): string =>
  body
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");
