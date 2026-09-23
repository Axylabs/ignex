/**
 * @fileoverview Codegen: generated runtime helper registry.
 *
 * Every helper is emitted into the server entry UNCONDITIONALLY. Dead helpers
 * (and their unused `@ignex/core` imports) are removed by the linker's
 * bundler — `Bun.build` treeshaking drops unreferenced top-level function
 * declarations and pure arrow consts, so no hand-rolled dependency tables or
 * usage tracking is maintained here.
 */

/**
 * Source of each generated runtime helper. Emitted unconditionally into the
 * server entry; the linker's bundler removes whatever no route references.
 */
export const HELPER_SOURCES: Record<string, string> = {
  __withBody: `const __staticBaseHeaders = new Map();
const __staticBaseFor = (type) => {
  let __base = __staticBaseHeaders.get(type);
  if (__base === undefined) {
    __base = new Headers({ "content-type": type, ...__DEFAULT_HEADERS });
    __staticBaseHeaders.set(type, __base);
  }
  return __base;
};
const __withBody = (payload, type, init) => {
  const ih = init && init.headers;
  let __response;
  if (__DEFAULT_HEADERS) {
    // App-invariant static defaults (plugin-declared security headers +
    // server.headers): one boot-memoized base Headers per content-type is the
    // shared skeleton. With NO per-request init headers it is handed to Response
    // — which COPIES it, so one base serves every concurrent request — and only
    // the dynamic content-length is set per request. When init headers ARE
    // present, the base is CLONED once (one native copy) and the request's own
    // headers are applied to the copy: re-building the record and re-applying
    // every static default through N Headers.set calls measured ~2.6x slower for
    // the 9-header set (a full-base clone costs ~57ns against ~205ns just to
    // build a 2-key record, Bun 1.4.2).
    const __base = __staticBaseFor(type);
    let __headers = __base;
    if (ih) {
      __headers = new Headers(__base);
      if (payload !== null) __headers.set("content-length", String(typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength));
      if (ih instanceof Headers || (typeof ih.forEach === "function" && !Array.isArray(ih))) {
        (ih.forEach)((value, key) => __headers.set(key, value));
      } else if (Array.isArray(ih)) {
        for (const [k, v] of ih) __headers.set(k, v);
      } else {
        for (const [k, v] of Object.entries(ih)) if (v != null) __headers.set(k, String(v));
      }
    }
    // ResponseInit is exactly { status, statusText, headers }: passing the
    // three known fields avoids the per-request destructure + rest-spread of
    // the caller's init object (measured ~95ns on the status-only path).
    if (init === undefined) __response = new Response(payload, { headers: __headers });
    else __response = new Response(payload, { status: init.status, statusText: init.statusText, headers: __headers });
    if (!ih && payload !== null) __response.headers.set("content-length", String(typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength));
  } else {
    // No static defaults: a small base record plus incremental header sets.
    // Bun's bulk plain-object header init costs more per header than
    // Headers.set, so a record built as 2 headers + N sets is cheaper than one
    // merged object (~56 vs ~84 ns/header). init/route headers are applied
    // afterward.
    const h = { "content-type": type };
    if (payload !== null) h["content-length"] = String(typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength);
    if (!ih) {
      if (init === undefined) __response = new Response(payload, { headers: h });
      else __response = new Response(payload, { status: init.status, statusText: init.statusText, headers: h });
    } else {
      const hh = new Headers(h);
      if (ih instanceof Headers || (typeof ih.forEach === "function" && !Array.isArray(ih))) {
        (ih.forEach)((value, key) => hh.set(key, value));
      } else if (Array.isArray(ih)) {
        for (const [k, v] of ih) hh.set(k, v);
      } else {
        for (const [k, v] of Object.entries(ih)) if (v != null) hh.set(k, String(v));
      }
      __response = new Response(payload, { status: init.status, statusText: init.statusText, headers: hh });
    }
  }
  // Tell decorating plugins (security) these headers are already baked in, so
  // they skip re-applying them via per-header native Headers.set calls.
  if (__DEFAULT_HEADERS) markDecoratedResponse(__response);
  return __response;
};`,
  /**
   * Apply the app's boot-memoized static default headers (`__DEFAULT_HEADERS`,
   * i.e. plugin `responseDefaults` + `server.headers`) to a response the
   * framework did NOT construct through `__withBody` — a raw `Response`
   * passthrough, the 404/405 fallback, an OPTIONS preflight, or an error.
   *
   * `__withBody` bakes the defaults into the header record at CONSTRUCTION and
   * registers the response as decorated; every other path missed them (Bun
   * 1.4.2 ignores `Bun.serve({ headers })`, so there is no runtime sink). This
   * helper only fills headers the response does not already carry, so a
   * route/plugin-specific value wins (matching `__withBody`'s init-header
   * precedence and `security()`'s Content-Security-Policy guard), then marks
   * the response decorated so the decorating plugin chain skips its static
   * loop (HSTS and other request-conditional headers still apply).
   *
   * Cost: for an already-decorated framework reply this is one `WeakSet` probe
   * that returns it unchanged; for an app with NO static defaults the
   * `__DEFAULT_HEADERS` guard const-folds the whole call away. It adds no
   * per-header work to the hot `__withBody` success path.
   */
  __decorateWithDefaults: `const __decorateWithDefaults = (response) => {
  if (!__DEFAULT_HEADERS || isDecoratedResponse(response)) return response;
  const __headers = response.headers;
  try {
    // Bun allows in-place response-header mutation: it keeps the body,
    // content-length and every existing header (including multiple
    // set-cookie values) intact, with no re-wrap allocation.
    for (const __k in __DEFAULT_HEADERS) {
      if (!__headers.has(__k)) __headers.set(__k, __DEFAULT_HEADERS[__k]);
    }
    markDecoratedResponse(response);
    return response;
  } catch {
    // Headers are immutable on a spec-strict runtime: copy + re-wrap.
    const __copy = new Headers(__headers);
    for (const __k in __DEFAULT_HEADERS) {
      if (!__copy.has(__k)) __copy.set(__k, __DEFAULT_HEADERS[__k]);
    }
    const __out = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: __copy,
    });
    markDecoratedResponse(__out);
    return __out;
  }
};`,
  jsonReply: `const jsonReply = (data, init) => {
  const s = JSON.stringify(data);
  if (s === undefined) return __withBody(null, "application/json; charset=utf-8", init);
  return __withBody(s, "application/json; charset=utf-8", init);
};`,
  textReply: `const textReply = (data, init) =>
  __withBody(String(data), "text/plain; charset=utf-8", init);`,
  htmlReply: `const htmlReply = (data, init) =>
  __withBody(String(data), "text/html; charset=utf-8", init);`,
  streamReply: `const streamReply = (stream, init) => new Response(stream, init);`,
  emptyReply: `const emptyReply = (status = 204) => new Response(null, { status });`,
  redirectReply: `const redirectReply = (url, status = 302) =>
  new Response(null, { status, headers: { location: String(url) } });`,
  statusReply: `const statusReply = (code) => new Response(null, { status: code });`,
  validationError: `const validationError = (errors, on) =>
  new ValidationError("Validation failed", errors, on);`,
  __applySet: `const __applySet = (response, set, requestId) => applySet(response, set, requestId, __TRACE);`,
  __finalize: `const __finalize = (result, ctx, serializers, reply) => {
  // NOTE: set is NOT applied here — the single outer __applySet applies
  // headers/status/cookies exactly once. Applying set inside __finalize AND
  // again in the route core fn caused duplicated set-cookie headers.
  const set = ctx?.set;
  // A raw handler Response passthrough (e.g. ctx.sendFile, a direct
  // Response.json, a stream) never went through __withBody, so apply the
  // app's static defaults here. Decorated replies are returned unchanged by
  // the helper (one WeakSet probe; const-folded when there are no defaults).
  if (result instanceof Response) {
    return __DEFAULT_HEADERS ? __decorateWithDefaults(result) : result;
  }
  if (result === undefined || result === null) {
    return __DEFAULT_HEADERS
      ? __decorateWithDefaults(new Response(null, { status: set?.status ?? 204 }))
      : new Response(null, { status: set?.status ?? 204 });
  }
  let status = set?.status;
  let body = result;
  if (typeof result === "object" && result !== null && "status" in result && "body" in result && Number.isInteger(result.status)) {
    status = status ?? result.status;
    body = result.body;
  }
  status = status ?? 200;
  const ser = serializers?.[status] ?? serializers?.["200"] ?? serializers?.default;
  if (ser) return __withBody(String(ser(body)), "application/json; charset=utf-8", { status });
  return reply(body, status === 200 ? undefined : { status });
};`,
  __handleError: `async function __handleError(err, ctx) {
  try {
    const __r = __TRACE_DEBUG ? runTimed("error", "lifecycle", () => runHooks(__lc.error, ctx, err)) : runHooks(__lc.error, ctx, err);
    const r = __r instanceof Promise ? await __r : __r;
    if (r.response) {
      const __hooked = __applySet(r.response, r.ctx?.set ?? ctx?.set);
      return __DEFAULT_HEADERS ? __decorateWithDefaults(__hooked) : __hooked;
    }
  } catch {
    // An error-stage hook that throws must not mask the original error.
  }
  const __errorResponse = errorToResponse(err, EXPOSE_ERRORS, ctx);
  return __DEFAULT_HEADERS ? __decorateWithDefaults(__errorResponse) : __errorResponse;
}`,
  __schemaFor: `const __schemaFor = (m) => m?.schema ?? m?.default?.schema ?? undefined;`,
  __validatePart: `async function __validatePart(schemaPart, input, on) {
  if (schemaPart !== undefined && schemaPart !== null) {
    await validateAsync(schemaPart, input, on);
  }
}`,
  __isServerLike: `const __isServerLike = (x) =>
  x && typeof x === "object" && ("requestIP" in x || "fetch" in x || "stop" in x);`,
  __extractParams: `function __extractParams(req, a, b) {
  if (req && typeof req === "object" && "params" in req && req.params) {
    return req.params;
  }

  if (a && typeof a === "object" && !__isServerLike(a)) return a;
  if (b && typeof b === "object" && !__isServerLike(b)) return b;

  return EMPTY_PARAMS;
}`,
  __extractServer: `function __extractServer(a, b) {
  if (__isServerLike(a)) return a;
  if (__isServerLike(b)) return b;
  return undefined;
}`,
  __wrap: `function __wrap(handler, wildcards = [], prefix) {
  return function (req, a, b) {
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

    // Non-async wrapper: the route core fns are already async, so wrapping
    // them in ANOTHER async fn (with its own Promise + microtask) is pure
    // overhead on the hot path. Return the handler's promise directly; both
    // a synchronous throw AND a promise rejection funnel into __handleError
    // (the async core catches sync throws, the .catch handles rejections).
    const onError = (err) => {
      const ctx = createContext(req, params ?? EMPTY_PARAMS, __ctxOpts);
      ctx.server = server;
      return __handleError(err, ctx);
    };

    try {
      const __r = handler(req, params ?? EMPTY_PARAMS, server);
      return __r instanceof Promise ? __r.catch(onError) : __r;
    } catch (err) {
      return onError(err);
    }
  };
}`,
  /**
   * Static-route wrapper — emitted for routes the compiler proved have NO
   * wildcard segments. The wildcard block (incl. the per-request
   * \`new URL(req.url)\` parse) disappears from the generated artifact instead
   * of being branch-checked at runtime.
   */
  __wrapStatic: `function __wrapStatic(handler) {
  return function (req, a, b) {
    const params = __extractParams(req, a, b) ?? EMPTY_PARAMS;
    const onError = (err) => {
      const ctx = createContext(req, params, __ctxOpts);
      ctx.server = __extractServer(a, b);
      return __handleError(err, ctx);
    };
    try {
      const r = handler(req, params, __extractServer(a, b));
      return r instanceof Promise ? r.catch(onError) : r;
    } catch (err) {
      return onError(err);
    }
  };
}`,
  /**
   * Static + statically-sync wrapper — for compact/specialized routes whose
   * core fn is non-async AND cannot resume asynchronously (no hooks, no
   * validation). No Promise check, no \`.catch\` funnel: the happy path returns
   * the Response directly; only a synchronous throw pays the error path.
   */
  __wrapStaticSync: `function __wrapStaticSync(handler) {
  return function (req, a, b) {
    const params = __extractParams(req, a, b) ?? EMPTY_PARAMS;
    try {
      return handler(req, params, __extractServer(a, b));
    } catch (err) {
      const ctx = createContext(req, params, __ctxOpts);
      ctx.server = __extractServer(a, b);
      return __handleError(err, ctx);
    }
  };
}`,
  // Shared HEAD-response derivation (status + headers, body stripped). Both
  // auto-HEAD wrappers delegate here so the strip logic exists exactly once.
  __stripForHead: `async function __stripForHead(res) {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}`,
  __head: `function __head(handler, wildcards = [], prefix) {
  const wrapped = __wrap(handler, wildcards, prefix);
  return async function (req, a, b) {
    return __stripForHead(await wrapped(req, a, b));
  };
}`,
  /** Auto-HEAD for static GET routes — no wildcard closure data at all. */
  __headStatic: `function __headStatic(handler) {
  const wrapped = __wrapStatic(handler);
  return async function (req, a, b) {
    return __stripForHead(await wrapped(req, a, b));
  };
}`,
  __optionsHandler: `async function __optionsHandler(req, params, server) {
  const url = new URL(req.url);
  const allow = __allowFor(url.pathname) ?? "OPTIONS";

  const ctx = createContext(req, params ?? EMPTY_PARAMS, __ctxOpts);
  ctx.server = server;

  // Run the full pre-handler chain so plugins/hooks apply to preflight too. A
  // throwing hook must not demote the 204 preflight to a 500 — fall back to
  // the plain preflight (status preserved, plugin headers lost).
  let response;
  try {
    const __r = runHooks(__preStages, ctx);
    const pre = __r instanceof Promise ? await __r : __r;
    if (__TRACE_DEBUG) debugStageEnd("request");
    response = pre.response ?? new Response(null, { status: 204 });
    response = __applySet(response, pre.ctx.set, __TRACE ? pre.ctx.requestId : undefined);
  } catch {
    response = new Response(null, { status: 204 });
  }

  const headers = new Headers(response.headers);
  if (!headers.has("access-control-allow-methods")) {
    headers.set("Allow", allow);
  }

  // A preflight short-circuits BEFORE the post-handler stages, so a
  // decorating plugin's onResponse never runs here: apply the app's static
  // defaults explicitly (a no-op when the app declares none).
  if (__DEFAULT_HEADERS) {
    return __decorateWithDefaults(new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }));
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
  __fallback: `let __optionsWrapped;
const __MISS_BODIES = {
  404: JSON.stringify({ error: "Not Found", status: 404, code: "NOT_FOUND" }),
  405: JSON.stringify({ error: "Method Not Allowed", status: 405, code: "METHOD_NOT_ALLOWED" }),
};
async function __fallback(req, server) {
  const url = new URL(req.url);

  // Dev error overlay: while a build-error marker exists (written by
  // \`ignex dev\` on a failed compile), every request renders the error page
  // so the failure is visible in the browser, not just the terminal. Dev-only
  // (production never checks the marker) and zero-cost on the common path
  // (the \`existsSync\` guard skips when the file is absent).
  if (process.env.NODE_ENV !== "production" && __DEV_ERROR_MARKER) {
    const __markerPath = (import.meta.dir || process.cwd()) + "/.ignex-build-error.json";
    if (existsSync(__markerPath)) {
      let __message = "Compilation failed";
      try {
        const __raw = readFileSync(__markerPath, "utf-8");
        const __parsed = JSON.parse(__raw);
        if (typeof __parsed?.message === "string") __message = __parsed.message;
      } catch {}
      // Function replacer: a string replacer would interpret dollar
      // substitution patterns ($&, $backtick, $') in the message and corrupt
      // the overlay (compiler/module messages commonly contain "$&").
      const __body = __DEV_OVERLAY_HTML.replace("__MESSAGE__", () =>
        __message.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
      );
      const __overlay = new Response(__body, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
      return __DEFAULT_HEADERS ? __decorateWithDefaults(__overlay) : __overlay;
    }
  }

  if (req.method === "OPTIONS") {
    // Memoized once (the wrapper is stateless) — a fresh closure per OPTIONS
    // request is pure garbage pressure. Static: the synthetic route has no
    // wildcard segments, so the cheaper static wrapper suffices.
    return (__optionsWrapped ??= __wrapStatic(__optionsHandler))(req, undefined, server);
  }

  const allow = __allowFor(url.pathname);
  const status = allow ? 405 : 404;
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (allow) headers.Allow = allow;

  // Body pre-stringified at module load — a route miss (scanner, probe,
  // stale link) pays no per-hit serialization.
  let response = new Response(allow ? __MISS_BODIES[405] : __MISS_BODIES[404], { status, headers });

  // Run the lifecycle so plugins/hooks (e.g. CORS, security headers) apply to
  // 404/405 responses too — matching interpreted behavior. A throwing hook
  // must not demote the 404/405 into a 500 — fall back to the plain
  // not-found response (status preserved, plugin headers lost).
  if (__hasPreStages || __hasPostStages || __hasAfterResponse) {
    const ctx = createContext(req, EMPTY_PARAMS, __ctxOpts);
    ctx.server = server;

    try {
      const __r1 = runHooks(__preStages, ctx);
      const pre = __r1 instanceof Promise ? await __r1 : __r1;
      if (__TRACE_DEBUG) debugStageEnd("request");
      if (pre.response) {
        // A pre-stage hook (e.g. the openapi() plugin serving its spec/UI
        // endpoints, which aren't in the compiled route table) short-circuited:
        // still run the response pipeline (CORS/security/compression) over the
        // intercepted response so it behaves like a real matched route.
        const __r2 = __TRACE_DEBUG ? runTimed("response", "lifecycle", () => runHooks(__postStages, pre.ctx, pre.response)) : runHooks(__postStages, pre.ctx, pre.response);
        const __post = __r2 instanceof Promise ? await __r2 : __r2;
        const __intercepted = __post.response ?? pre.response;
        const __r3 = __TRACE_DEBUG ? runTimed("afterResponse", "lifecycle", () => runHooks(__lc.afterResponse ?? [], pre.ctx, __intercepted)) : runHooks(__lc.afterResponse ?? [], pre.ctx, __intercepted);
        if (__r3 instanceof Promise) await __r3;
        const __shortCircuit = __applySet(__intercepted, pre.ctx.set, __TRACE ? pre.ctx.requestId : undefined);
        return __DEFAULT_HEADERS ? __decorateWithDefaults(__shortCircuit) : __shortCircuit;
      }

      const __r2 = __TRACE_DEBUG ? runTimed("response", "lifecycle", () => runHooks(__postStages, pre.ctx, response)) : runHooks(__postStages, pre.ctx, response);
      const post = __r2 instanceof Promise ? await __r2 : __r2;
      response = post.response ?? response;
      const __r3 = __TRACE_DEBUG ? runTimed("afterResponse", "lifecycle", () => runHooks(__lc.afterResponse ?? [], pre.ctx, response)) : runHooks(__lc.afterResponse ?? [], pre.ctx, response);
      if (__r3 instanceof Promise) await __r3;
      response = __applySet(response, pre.ctx.set, __TRACE ? pre.ctx.requestId : undefined);
    } catch {
      // keep the plain 404/405 response
    }
  }

  // A no-lifecycle 404/405 never ran a decorating plugin, so apply the app's
  // static defaults explicitly (already-decorated responses are untouched).
  return __DEFAULT_HEADERS ? __decorateWithDefaults(response) : response;
}`,
};

/** Indent every non-empty line of a multi-line code block by two spaces. */
export const indentBody = (body: string): string =>
  body
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");
