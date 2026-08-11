/**
 * @fileoverview Codegen: per-route handler emission (`generateRouteCode`).
 *
 * Emits each route's core function (constant-hoisted, full-context, or
 * usage-specialized) plus its cache wrapper. Reads/writes the shared
 * `CodegenState` (functions, cacheDecls, helpers).
 */

import type { CompilerOptions, RouteDef } from "../../types";
import { getCacheConfig, tryNormalizeConstant } from "./decisions";
import {
  cacheVar,
  constantBodyVar,
  constantInitVar,
  coreHandlerName,
  handlerImportName,
  hookIdent,
  methodHandlerName,
  routeReplyFn,
  validatorImportName,
} from "./identifiers";
import type { CodegenState } from "./state";

/**
 * Emit the code for a single route. Deduplicated (non-leader) routes reuse the
 * leader's handler and emit nothing here.
 */
export const generateRouteCode = (
  state: CodegenState,
  route: RouteDef,
  opts: CompilerOptions,
): void => {
  const { cfg, hasAppConfig, helpers, functions, cacheDecls } = state;

  // Deduplicated (non-leader) routes reuse the leader's handler; only the
  // leader emits it.
  if (route.decisions.dedupGroup) return;

  const constantJson = tryNormalizeConstant(route, hasAppConfig);

  // Constant responses are hoisted to zero-cost frozen bodies — unless the
  // app has a lifecycle/plugins (hooks would be bypassed), trace headers or
  // access logging are enabled (need a per-request context), or constant
  // hoisting is disabled by the optimization level. In those cases the route
  // falls through to the normal (full or specialized) path.
  if (
    cfg.hoistConstants &&
    constantJson !== null &&
    !cfg.enableTraceHeaders &&
    !cfg.enableAccessLog
  ) {
    functions.push(`const ${constantBodyVar(route)} = ${constantJson};`);

    functions.push(`const ${constantInitVar(route)} = Object.freeze({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
});`);

    functions.push(`function ${methodHandlerName(route)}(req, params, server) {
  return new Response(${constantBodyVar(route)}, ${constantInitVar(route)});
}`);

    return;
  }

  const hasHooks = route.analysis.hooks.length > 0;

  const hasGlobalLifecycle = !!hasAppConfig;

  // Usage-driven context specialization. A full context is required when the
  // route needs lifecycle/hooks, validation, cookies, forwarding, or file
  // handling, or when context specialization is disabled. This is driven by
  // the AST-derived ContextUsage, not a substring scan of the source.
  const needsFull =
    !cfg.specializeContext ||
    cfg.enableTraceHeaders ||
    cfg.enableAccessLog ||
    hasHooks ||
    hasGlobalLifecycle ||
    route.analysis.hasValidation ||
    route.analysis.usage.cookie ||
    route.analysis.usage.set ||
    route.analysis.usage.proxy ||
    route.analysis.usage.forward ||
    route.analysis.usage.cache ||
    route.analysis.usage.loader ||
    route.analysis.usage.sendFile ||
    route.analysis.usage.file;

  const hasParamsValidator = !!route.decisions.validators?.params;
  const hasQueryValidator = !!route.decisions.validators?.query;
  const hasHeadersValidator = !!route.decisions.validators?.headers;
  const hasBodyValidator = !!route.decisions.validators?.body;
  const hasCookieValidator = !!route.decisions.validators?.cookie;

  const cacheConfig = getCacheConfig(route, cfg);
  const coreName = coreHandlerName(route, !!cacheConfig);

  helpers.markUsed(routeReplyFn(route));
  helpers.markUsed("__finalize");
  helpers.markUsed("__applySet");
  helpers.markUsed("__handleError");

  const pre: string[] = [];
  let callExpr = "";

  if (needsFull) {
    helpers.markCore("runHooks");
    helpers.markCore("createContext");
    pre.push(
      `let ctx = createContext(req, params ?? EMPTY_PARAMS, { body: BODY_LIMITS, route: ${JSON.stringify(route.source.path)} });`,
    );
    pre.push(`ctx.server = server;`);
    pre.push(`{
  // start → request → parse → transform run before validation; beforeHandle
  // and per-route hooks run after validation (see below). This keeps the
  // compiled stage order aligned with the interpreted runLifecycle.
  const __globalPre = await runHooks(__preParseStages, ctx);
  if (__globalPre.response) return __applySet(__globalPre.response, ctx.set);
  ctx = __globalPre.ctx ?? ctx;
}`);

    // Per-route hooks run ONCE, after the global beforeHandle stage and
    // before the handler (see `rBefore` in the generated route fn below).
    // Removing the previous pre-validation copy eliminated a double run.
    if (
      route.analysis.hasValidation ||
      hasParamsValidator ||
      hasQueryValidator ||
      hasHeadersValidator ||
      hasBodyValidator ||
      hasCookieValidator
    ) {
      helpers.markUsed("__schemaFor");
      helpers.markUsed("__validatePart");
      helpers.markCore("parseQueryFromURL");

      if (
        hasParamsValidator ||
        hasQueryValidator ||
        hasHeadersValidator ||
        hasBodyValidator ||
        hasCookieValidator
      ) {
        helpers.markUsed("validationError");
      }

      if (hasCookieValidator || opts.validateCookies !== false) {
        helpers.markCore("parseCookieString");
      }

      pre.push(
        `const __schema = ${
          route.analysis.hasValidation
            ? `__schemaFor(schema_${route.codegen.handlerRef})`
            : `undefined`
        };`,
      );

      // Params
      if (hasParamsValidator) {
        pre.push(`if (!${validatorImportName(route, "params")}(ctx.params)) {
  throw validationError(${validatorImportName(route, "params")}.errors ?? {}, "params");
}`);
      } else {
        pre.push(`await __validatePart(__schema?.params, ctx.params, "params");`);
      }

      // Query
      pre.push(`const __query = parseQueryFromURL(req.url);`);

      if (hasQueryValidator) {
        pre.push(`if (!${validatorImportName(route, "query")}(__query)) {
  throw validationError(${validatorImportName(route, "query")}.errors ?? {}, "query");
}`);
      } else {
        pre.push(`await __validatePart(__schema?.query, __query, "query");`);
      }

      pre.push(`Object.defineProperty(ctx, "query", { value: __query, configurable: true });`);

      // Headers
      pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);

      if (hasHeadersValidator) {
        pre.push(`if (!${validatorImportName(route, "headers")}(__headers)) {
  throw validationError(${validatorImportName(route, "headers")}.errors ?? {}, "headers");
}`);
      } else {
        pre.push(`await __validatePart(__schema?.headers, __headers, "headers");`);
      }

      // Cookies
      if (hasCookieValidator || opts.validateCookies !== false) {
        pre.push(`const __cookies = parseCookieString(req.headers.get("cookie"));`);

        if (hasCookieValidator) {
          pre.push(`if (!${validatorImportName(route, "cookie")}(__cookies)) {
  throw validationError(${validatorImportName(route, "cookie")}.errors ?? {}, "cookie");
}`);
        } else {
          pre.push(`await __validatePart(__schema?.cookie, __cookies, "cookie");`);
        }
      }

      // Body
      if (hasBodyValidator) {
        pre.push(`const __body = await ctx.body.json();`);
        pre.push(`if (!${validatorImportName(route, "body")}(__body)) {
  throw validationError(${validatorImportName(route, "body")}.errors ?? {}, "body");
}`);
        pre.push(`ctx.body.json = async () => __body;`);
      } else {
        pre.push(`if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && __schema?.body) {
  const __body = await ctx.body.json();
  await __validatePart(__schema.body, __body, "body");
  ctx.body.json = async () => __body;
}`);
      }
    }

    // Call the handler directly. `__lc.afterHandle` (user hooks + plugin
    // `onResponse`) must NOT run on the raw handler result — plugin hooks
    // expect a `Response`, and running them on a plain object would break
    // (e.g. reading `response.status`). They run once, on the finalized
    // response, in the outer `runHooks(__lc.afterHandle ?? __lc.onResponse, ...)`
    // call below.
    callExpr = `${handlerImportName(route)}(ctx)`;
  } else {
    pre.push(`const __params = params ?? EMPTY_PARAMS;`);

    if (hasParamsValidator) {
      helpers.markUsed("validationError");
      pre.push(`if (!${validatorImportName(route, "params")}(__params)) {
  throw validationError(${validatorImportName(route, "params")}.errors ?? {}, "params");
}`);
    }

    const needUrl = route.analysis.usage.url || (route.analysis.usage.query && !hasQueryValidator);

    if (needUrl) {
      pre.push(`const url = new URL(req.url);`);
    }

    if (route.analysis.usage.query || hasQueryValidator) {
      if (hasQueryValidator) {
        helpers.markUsed("validationError");
        helpers.markCore("parseQueryFromURL");
        pre.push(`const query = parseQueryFromURL(req.url);`);
        pre.push(`if (!${validatorImportName(route, "query")}(query)) {
  throw validationError(${validatorImportName(route, "query")}.errors ?? {}, "query");
}`);
      } else {
        pre.push(`const query = url.searchParams;`);
      }
    }

    if (route.analysis.usage.headers || hasHeadersValidator) {
      if (hasHeadersValidator) {
        helpers.markUsed("validationError");
        pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);
        pre.push(`if (!${validatorImportName(route, "headers")}(__headers)) {
  throw validationError(${validatorImportName(route, "headers")}.errors ?? {}, "headers");
}`);
      }
    }

    if (route.analysis.usage.body || hasBodyValidator) {
      helpers.markCore("createLazyBody");

      if (hasBodyValidator) {
        helpers.markUsed("validationError");
      }

      pre.push(`let body = createLazyBody(req, BODY_LIMITS);`);

      if (hasBodyValidator) {
        pre.push(`const __body = await body.json();`);
        pre.push(`if (!${validatorImportName(route, "body")}(__body)) {
  throw validationError(${validatorImportName(route, "body")}.errors ?? {}, "body");
}`);
        pre.push(`body.json = async () => __body;`);
      }
    }

    if (route.analysis.usage.state) {
      pre.push(`const state = new Map();`);
    }

    if (route.analysis.usage.set || route.analysis.usage.cookie) {
      pre.push(`const __set = { headers: Object.create(null), cookie: Object.create(null) };`);
    } else {
      pre.push(`const __set = __EMPTY_SET;`);
    }

    if (route.analysis.usage.cookie) {
      helpers.markCore("createCookieJar");
      helpers.markCore("parseCookieString");
      pre.push(
        `const __cookieJar = createCookieJar(__set, {}, parseCookieString(req.headers.get("cookie")));`,
      );
    }

    const props: string[] = [];
    props.push(`set: __set`);

    if (route.analysis.usage.params || hasParamsValidator) {
      props.push(`params: __params`);
    }

    if (route.analysis.usage.body || hasBodyValidator) {
      props.push(`body`);
    }

    if (route.analysis.usage.query || hasQueryValidator) {
      props.push(`query`);
    }

    if (route.analysis.usage.headers || hasHeadersValidator) {
      props.push(`headers: req.headers`);
    }

    if (route.analysis.usage.req) {
      props.push(`req`);
    }

    if (route.analysis.usage.url) {
      props.push(`url`);
    }

    if (route.analysis.usage.server) {
      props.push(`server`);
    }

    if (route.analysis.usage.state) {
      props.push(`state`);
      props.push(`getState: (key) => state.get(key)`);
      props.push(`setState: (key, value) => { state.set(key, value); }`);
    }

    if (route.analysis.usage.json) {
      helpers.markUsed("jsonReply");
      props.push(`json: jsonReply`);
    }
    if (route.analysis.usage.text) {
      helpers.markUsed("textReply");
      props.push(`text: textReply`);
    }
    if (route.analysis.usage.html) {
      helpers.markUsed("htmlReply");
      props.push(`html: htmlReply`);
    }
    if (route.analysis.usage.stream) {
      helpers.markUsed("streamReply");
      props.push(`stream: streamReply`);
    }
    if (route.analysis.usage.redirect) {
      helpers.markUsed("redirectReply");
      props.push(`redirect: redirectReply`);
    }
    if (route.analysis.usage.empty) {
      helpers.markUsed("emptyReply");
      props.push(`empty: emptyReply`);
    }
    if (route.analysis.usage.status) {
      helpers.markUsed("statusReply");
      props.push(`status: statusReply`);
    }

    if (route.analysis.usage.sendFile) {
      helpers.markCore("sendFile");
      props.push(`sendFile: (path, opts) => sendFile(path, { req, ...opts })`);
    }

    if (route.analysis.usage.cookie) {
      props.push(`cookie: __cookieJar`);
    }

    if (route.analysis.usage.proxy) {
      helpers.markCore("proxyRequest");
      props.push(`proxy: (target, opts) => proxyRequest(target, { req, ...opts })`);
    }

    if (route.analysis.usage.forward) {
      helpers.markCore("forwardRequest");
      props.push(`forward: (target, opts) => forwardRequest(req, target, opts)`);
    }

    callExpr =
      props.length === 0
        ? `${handlerImportName(route)}({})`
        : `${handlerImportName(route)}({ ${props.join(", ")} })`;
  }

  const serializersVar = route.decisions.serializers?.byStatus
    ? `{ ${Object.entries(route.decisions.serializers.byStatus)
        .map(([s, n]) => `${JSON.stringify(s)}: ${n}`)
        .join(", ")} }`
    : route.decisions.serializers?.json
      ? `{ "200": ${route.decisions.serializers.json} }`
      : "undefined";

  const routeHookVar =
    route.analysis.hooks.length > 0 ? `[${route.analysis.hooks.map(hookIdent).join(", ")}]` : `[]`;

  const coreFn = `async function ${coreName}(req, params, server) {
  let ctx;
  try {
    ${pre.join("\n")}
    ${
      needsFull
        ? `
    const gBefore = await runHooks(__lc.beforeHandle, ctx);
    ctx = gBefore.ctx ?? ctx;
    if (gBefore.response) return __applySet(gBefore.response, ctx.set);

    const rBefore = await runHooks(${routeHookVar}, ctx);
    ctx = rBefore.ctx ?? ctx;
    if (rBefore.response) return __applySet(rBefore.response, ctx.set);
    `
        : ""
    }
    const result = await ${callExpr};
    let response = __finalize(result, ${needsFull ? "ctx" : "{ set: __set }"}, ${serializersVar}, ${routeReplyFn(route)});
    ${
      needsFull
        ? `
    const after = await runHooks(__lc.afterHandle, ctx, response);
    ctx = after.ctx ?? ctx;
    response = after.response ?? response;
    const mapped = await runHooks(__lc.mapResponse, ctx, response);
    ctx = mapped.ctx ?? ctx;
    response = mapped.response ?? response;
    // Observe-only post-handler stages: a throwing afterResponse/trace hook
    // must not corrupt an already-finalized response (matches interpreted),
    // but the error is surfaced so broken hooks are debuggable.
    try { await runHooks(__lc.afterResponse, ctx, response); } catch (__err) { console.error("[flux] afterResponse hook error:", __err); }
    try { await runHooks(__lc.trace, ctx, response); } catch (__err) { console.error("[flux] trace hook error:", __err); }
    if (__ACCESS_LOG) {
      const __ms = (performance.now() - ctx.startTime).toFixed(2);
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: ${JSON.stringify(cfg.serviceName)}, requestId: ctx.requestId, method: req.method, path: ctx.path, status: response.status, ms: Number(__ms) }));
    }
    return __applySet(response, ctx.set, ctx.requestId);
    `
        : `return __applySet(response, __set);`
    }
  } catch (err) {
    return __handleError(err, ${needsFull ? "ctx" : "undefined"});
  }
}`;

  functions.push(coreFn);

  if (cacheConfig) {
    helpers.markCore("HttpResponseCache");
    cacheDecls.push(
      `const ${cacheVar(route)} = new HttpResponseCache(${JSON.stringify({
        max: 1000,
        ...cacheConfig,
      })});`,
    );

    functions.push(`function ${methodHandlerName(route)}(req, params, server) {
  return ${cacheVar(route)}.getOrSet(req, () => ${coreName}(req, params, server), ${JSON.stringify(
    cacheConfig,
  )});
}`);
  } else {
    functions.push(coreFn);
  }
};
