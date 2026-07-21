/**
 * Flux AOT Code Generator — Bun 1.4 native router edition.
 *
 * Emits Bun.serve({ routes }) instead of custom regex/trie runtime matching.
 */

import { join, relative } from "path";
import { existsSync } from "fs";
import type {
  RouteDef,
  ModuleInfo,
  CompilerOptions,
  HookDef,
} from "../types";

import type { Logger } from "../logger";

interface CodegenConfig {
  target: "bun";
  tracing: boolean;
  lifecycle: boolean;
  serviceName: string;
  exposeErrorDetails: boolean;
  specializeContext: boolean;
  reusePort: boolean;
  router: string;
  inlineHooks: boolean;
  routeCache: boolean;
}

const getConfig = (opts: CompilerOptions): CodegenConfig => ({
  target: opts.target,
  tracing: opts.enableTracing ?? false,
  lifecycle: opts.enableLifecycle ?? true,
  serviceName: opts.serviceName ?? "flux",
  exposeErrorDetails: opts.exposeErrorDetails ?? false,
  specializeContext: opts.specializeContext ?? true,
  reusePort: opts.reusePort ?? false,
  router: opts.router ?? "bun-native",
  inlineHooks: opts.inlineHooks ?? true,
  routeCache: opts.routeCache ?? true,
});

const toImportPath = (absPath: string, opts: CompilerOptions): string => {
  let rel = relative(opts.outDir, absPath)
    .replace(/\\/g, "/")
    .replace(/\.(ts|tsx|js|mjs|jsx)$/, "");

  if (!rel.startsWith(".")) rel = "./" + rel;

  return rel;
};

const runtimeImport = (projectPath: string, opts: CompilerOptions): string =>
  toImportPath(join(process.cwd(), projectPath), opts);

const handlerImportName = (route: RouteDef): string =>
  `handler_${route.handlerRef}`;

const methodHandlerName = (route: RouteDef): string =>
  `${route.method}_${route.handlerRef}`;

const finalizeName = (route: RouteDef): string =>
  `finalize_${route.handlerRef}`;

const constantBodyVar = (route: RouteDef): string =>
  `BODY_${route.handlerRef}`;

const constantInitVar = (route: RouteDef): string =>
  `INIT_${route.handlerRef}`;

const hookIdent = (name: string): string =>
  `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

const cacheVar = (route: RouteDef): string =>
  `CACHE_${route.handlerRef}`;

const coreHandlerName = (route: RouteDef, hasCache: boolean): string =>
  hasCache ? `core_${route.handlerRef}` : methodHandlerName(route);

const validatorImportName = (route: RouteDef, kind: string): string =>
  `validate_${route.handlerRef}_${kind}`;

const serializerImportName = (route: RouteDef): string =>
  `serialize_${route.handlerRef}`;

const routeReplyFn = (route: RouteDef): string => {
  if (route.responseType === "text") return "textReply";
  if (route.responseType === "html") return "htmlReply";
  if (route.responseType === "stream") return "streamReply";
  return "jsonReply";
};

const tryNormalizeConstant = (route: RouteDef): string | null => {
  if (!route.isConstantResponse || !route.constantResponse) return null;
  if (route.hooks.length > 0) return null;
  if (route.hasValidation) return null;

  if (route.validators && Object.keys(route.validators).length > 0) {
    return null;
  }

  try {
    JSON.parse(route.constantResponse);
    return route.constantResponse;
  } catch {
    return null;
  }
};

const getCacheConfig = (
  route: RouteDef,
  cfg: CodegenConfig
):
  | {
    ttlMs?: number;
    staleTtlMs?: number;
    vary?: string[];
  }
  | undefined => {
  if (!cfg.routeCache) return undefined;
  if (route.method !== "GET" && route.method !== "HEAD") return undefined;

  const cache = route.cache;
  if (!cache) return undefined;

  const out: {
    ttlMs?: number;
    staleTtlMs?: number;
    vary?: string[];
  } = {};

  if (typeof cache.maxAge === "number") {
    out.ttlMs = cache.maxAge * 1000;
  }

  if (typeof cache.swr === "number") {
    out.staleTtlMs = cache.swr * 1000;
  }

  if (Array.isArray(cache.vary)) {
    out.vary = [...cache.vary];
  }

  return Object.keys(out).length > 0 ? out : undefined;
};

const bunRoutePath = (path: string): string =>
  path.replace(/\*([A-Za-z0-9_]+)/g, "*");

const wildcardNames = (path: string): string[] =>
  Array.from(path.matchAll(/\*([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);

const FORCE_FULL_TOKENS = [
  "ctx.cookie",
  "ctx.server",
  "ctx.set",
  "ctx.proxy",
  "ctx.forward",
  "ctx.cache",
];

export const generateServer = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions
): string => {
  const cfg = getConfig(opts);

  const imports = new Set<string>();
  const header: string[] = [];
  const cacheDecls: string[] = [];
  const functions: string[] = [];

  const corePath = "@flux/core";

  const appConfigPath = (opts as any).appConfig;
  const hasAppConfig = typeof appConfigPath === "string" && appConfigPath.length > 0 && existsSync(join(process.cwd(), appConfigPath));

  const coreNames = [
    "createContext",
    "createLazyBody",
    "parseQueryFromURL",
    "errorToResponse",
    "sendFile",
    "HttpResponseCache",
    "ValidationError",
    "serializeCookie",
    "parseCookieString",
    "createCookieJar",
    "validateAsync",
    "EMPTY_LIFECYCLE",
  ];

  if (hasAppConfig) {
    coreNames.push("createPluginContext", "mergeLifeCycle", "pluginsToLifeCycle");
  }

  for (const route of routes) {
    if (route.usage.proxy) coreNames.push("proxyRequest");
    if (route.usage.forward) coreNames.push("forwardRequest");
  }

  const uniqueCore = [...new Set(coreNames)].sort();
  imports.add(
    `import { ${uniqueCore.join(", ")} } from ${JSON.stringify(corePath)};`
  );

  if (hasAppConfig) {
    imports.add(
      `import * as __appConfig from ${JSON.stringify(
        toImportPath(join(process.cwd(), appConfigPath), opts)
      )};`
    );
  }

  for (const route of routes) {
    const mod = modules[route.moduleIdx];

    if (mod) {
      imports.add(
        `import ${handlerImportName(route)} from ${JSON.stringify(
          toImportPath(mod.path, opts)
        )};`
      );
      if (route.hasValidation) {
        imports.add(
          `import * as schema_${route.handlerRef} from ${JSON.stringify(
            toImportPath(mod.path, opts)
          )};`
        );
      }
    }

    if (route.validators) {
      const kinds = ["body", "query", "params", "headers", "cookie"] as const;

      for (const kind of kinds) {
        if (route.validators[kind]) {
          imports.add(
            `import ${validatorImportName(
              route,
              kind
            )} from "./validators/${route.handlerRef}.${kind}.cjs";`
          );
        }
      }
    }

    if (route.serializers?.json) {
      imports.add(
        `import ${serializerImportName(
          route
        )} from "./serializers/${route.handlerRef}.200.mjs";`
      );
    }

    for (const hookName of route.hooks) {
      const hook = hooks.get(hookName);

      if (hook) {
        imports.add(
          `import ${hookIdent(hookName)} from ${JSON.stringify(
            toImportPath(join(process.cwd(), hook.source), opts)
          )};`
        );
      }
    }
  }

  header.push(`const EMPTY_PARAMS = Object.freeze({});`);

  header.push(`const BODY_LIMITS = Object.freeze({
  maxJsonBytes: ${opts.maxJsonBytes ?? 2 * 1024 * 1024},
  maxTextBytes: ${opts.maxTextBytes ?? 2 * 1024 * 1024},
  maxFormBytes: ${opts.maxFormBytes ?? 2 * 1024 * 1024},
  maxFileBytes: ${opts.maxFileBytes ?? 20 * 1024 * 1024},
});`);

  header.push(`const EXPOSE_ERRORS = ${cfg.exposeErrorDetails ? "true" : "false"};`);

  if (hasAppConfig) {
    imports.add(
      `import * as __appConfig from ${JSON.stringify(
        toImportPath(join(process.cwd(), appConfigPath), opts)
      )};`
    );

    header.push(`const __pluginContext = createPluginContext();`);
    header.push(`for (const __p of __appConfig.plugins ?? []) {
  if (typeof __p === "function") await __p(__pluginContext);
  else if (__p && typeof __p.setup === "function") await __p.setup(__pluginContext);
}`);
    header.push(`const __pluginLC = pluginsToLifeCycle(__appConfig.plugins ?? []);`);
    header.push(`const __userLC = __appConfig.lifecycle ?? __appConfig.hooks ?? {};`);
    header.push(`const __lc = mergeLifeCycle(mergeLifeCycle(EMPTY_LIFECYCLE, __pluginLC), __userLC);`);
    header.push(`const __serverCfg = __appConfig.server ?? {};`);
  } else {
    header.push(`const __lc = EMPTY_LIFECYCLE;`);
    header.push(`const __serverCfg = {};`);
  }
  header.push(`const jsonReply = (data, init) => Response.json(data, init);`);

  header.push(`const textReply = (data, init) =>
  new Response(
    String(data),
    init
      ? { ...init, headers: { "content-type": "text/plain; charset=utf-8", ...init.headers } }
      : { headers: { "content-type": "text/plain; charset=utf-8" } }
  );`);

  header.push(`const htmlReply = (data, init) =>
  new Response(
    String(data),
    init
      ? { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } }
      : { headers: { "content-type": "text/html; charset=utf-8" } }
  );`);

  header.push(`const streamReply = (stream, init) => new Response(stream, init);`);

  header.push(`const emptyReply = (status = 204) => new Response(null, { status });`);

  header.push(`const redirectReply = (url, status = 302) => Response.redirect(url, status);`);

  header.push(`const statusReply = (code) => new Response(null, { status: code });`);

  header.push(`const validationError = (errors, on) =>
  new ValidationError("Validation failed", errors, on);`);

  header.push(`const __applySet = (response, set) => {
  if (!set) return response;
  const h = new Headers(response.headers);
  if (set.headers) {
    for (const [k, v] of Object.entries(set.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) { h.delete(k); for (const x of v) h.append(k, String(x)); }
      else h.set(k, String(v));
    }
  }
  if (set.cookie && typeof set.cookie === "object") {
    const s = serializeCookie(set.cookie);
    if (s) {
      if (Array.isArray(s)) for (const c of s) h.append("set-cookie", c);
      else h.append("set-cookie", s);
    }
  }
  return new Response(response.body, { status: set.status ?? response.status, headers: h, statusText: response.statusText });
};`);

  header.push(`const __finalize = (result, ctx, serializers, reply) => {
  const set = ctx?.set;
  if (result instanceof Response) return __applySet(result, set);
  if (result === undefined || result === null) return __applySet(new Response(null, { status: set?.status ?? 204 }), set);
  let status = set?.status;
  let body = result;
  if (typeof result === "object" && result !== null && "status" in result && "body" in result && Number.isInteger(result.status)) {
    status = status ?? result.status;
    body = result.body;
  }
  status = status ?? 200;
  const ser = serializers?.[String(status)] ?? serializers?.["200"] ?? serializers?.default;
  if (ser) return __applySet(new Response(ser(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }), set);
  return __applySet(reply(body, { status }), set);
};`);

  header.push(`async function __runHooks(hooks, ctx, arg) {
  let c = ctx;
  for (const entry of hooks ?? []) {
    const fn = typeof entry === "function" ? entry : entry?.fn;
    if (typeof fn !== "function") continue;
    const r = arg === undefined ? await fn(c) : await fn(c, arg);
    if (r instanceof Response) return { response: r, ctx: c };
    if (r && typeof r === "object") {
      if (r.ok === false && r.response instanceof Response) return { response: r.response, ctx: c };
      if (r.response instanceof Response) return { response: r.response, ctx: c };
      if (r.ctx) c = r.ctx;
    }
  }
  return { ctx: c };
}`);

  header.push(`async function __handleError(err, ctx) {
  try {
    const r = await __runHooks(__lc.error ?? __lc.onError, ctx, err);
    if (r.response) return __applySet(r.response, r.ctx?.set ?? ctx?.set);
  } catch {}
  return errorToResponse(err, EXPOSE_ERRORS);
}`);

  header.push(`const __schemaFor = (m) => m?.schema ?? m?.default?.schema ?? undefined;`);

  header.push(`async function __validatePart(schemaPart, input, on) {
  if (schemaPart !== undefined && schemaPart !== null) {
    await validateAsync(schemaPart, input, on);
  }
}`);

  header.push(`function __extractParams(req, a, b) {
  if (req && typeof req === "object" && "params" in req && req.params) {
    return req.params;
  }

  const isServerLike = (x) =>
    x && typeof x === "object" && ("requestIP" in x || "fetch" in x || "stop" in x);

  if (a && typeof a === "object" && !isServerLike(a)) return a;
  if (b && typeof b === "object" && !isServerLike(b)) return b;

  return EMPTY_PARAMS;
}`);

  header.push(`function __extractServer(a, b) {
  const isServerLike = (x) =>
    x && typeof x === "object" && ("requestIP" in x || "fetch" in x || "stop" in x);

  if (isServerLike(a)) return a;
  if (isServerLike(b)) return b;
  return undefined;
}`);

  header.push(`function __wrap(handler, wildcards = []) {
  return async function (req, a, b) {
    let params = __extractParams(req, a, b);

    if (wildcards.length && params && params["*"] != null) {
      params = { ...params };
      for (const name of wildcards) {
        params[name] = params["*"];
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
}`);

  header.push(`function __head(handler, wildcards = []) {
  const wrapped = __wrap(handler, wildcards);

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
}`);

  header.push(`async function __optionsHandler(req, params, server) {
  const url = new URL(req.url);
  const allow = __allowFor(url.pathname) ?? "OPTIONS";

  const ctx = createContext(req, params ?? EMPTY_PARAMS, { body: BODY_LIMITS });
  ctx.server = server;

  const r = await __runHooks(__lc.request ?? [], ctx);
  if (r.response) {
    const headers = new Headers(r.response.headers);
    if (!headers.has("access-control-allow-methods")) {
      headers.set("Allow", allow);
    }

    return new Response(r.response.body, {
      status: r.response.status,
      statusText: r.response.statusText,
      headers,
    });
  }

  return new Response(null, {
    status: 204,
    headers: {
      Allow: allow,
    },
  });
}`);

  const generateRouteCode = (route: RouteDef): void => {
    const mod = modules[route.moduleIdx];
    const constantJson = tryNormalizeConstant(route);

    if (constantJson !== null) {
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

    const hasHooks = route.hooks.length > 0;

    const hasGlobalLifecycle = !!hasAppConfig;

    const needsFull =
      !cfg.specializeContext ||
      hasHooks ||
      hasGlobalLifecycle ||
      route.hasValidation ||
      route.usage.cookie ||
      route.usage.set ||
      route.usage.proxy ||
      route.usage.forward ||
      route.usage.cache ||
      route.usage.sendFile ||
      route.usage.file ||
      (mod ? FORCE_FULL_TOKENS.some((token) => mod.content.includes(token)) : false);

    const hasParamsValidator = !!route.validators?.params;
    const hasQueryValidator = !!route.validators?.query;
    const hasHeadersValidator = !!route.validators?.headers;
    const hasBodyValidator = !!route.validators?.body;
    const hasCookieValidator = !!route.validators?.cookie;

    const serializer = route.serializers?.json;

    const cacheConfig = getCacheConfig(route, cfg);
    const coreName = coreHandlerName(route, !!cacheConfig);

    const finalizerCode = `function ${finalizeName(route)}(result) {
  if (result instanceof Response) return result;
  if (result === undefined) return new Response(null, { status: 204 });
  ${serializer
        ? `return new Response(${serializer}(result), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });`
        : `return ${routeReplyFn(route)}(result);`
      }
}`;

    const pre: string[] = [];
    let callExpr = "";

    if (needsFull) {
      pre.push(`let ctx = createContext(req, params ?? EMPTY_PARAMS, { body: BODY_LIMITS });`);
      pre.push(`ctx.server = server;`);
      pre.push(`{
  const __globalRequest = await __runHooks(__lc.request ?? [], ctx);
  if (__globalRequest.response) return __globalRequest.response;
  ctx = __globalRequest.ctx ?? ctx;
}`);

      for (const hookName of route.hooks) {
        if (!hooks.has(hookName)) continue;

        pre.push(`{
  const r = await ${hookIdent(hookName)}(ctx);
  if (r instanceof Response) return r;
  if (r && typeof r === "object") {
    if (r.ok === false && r.response instanceof Response) return r.response;
    if (r.ctx) ctx = r.ctx;
  }
}`);
      }

      if (
        route.hasValidation ||
        hasParamsValidator ||
        hasQueryValidator ||
        hasHeadersValidator ||
        hasBodyValidator ||
        hasCookieValidator
      ) {
        pre.push(
          `const __schema = ${route.hasValidation ? `__schemaFor(schema_${route.handlerRef})` : `undefined`
          };`
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

      callExpr = `(async () => {
  let __result = await ${handlerImportName(route)}(ctx);

  const __after = await __runHooks(__lc.afterHandle ?? [], ctx, __result);
  if (__after.response) return __after.response;

  return __result;
})()`;
    } else {
      pre.push(`const __params = params ?? EMPTY_PARAMS;`);

      if (hasParamsValidator) {
        pre.push(`if (!${validatorImportName(route, "params")}(__params)) {
  throw validationError(${validatorImportName(route, "params")}.errors ?? {}, "params");
}`);
      }

      const needUrl =
        route.usage.url || (route.usage.query && !hasQueryValidator);

      if (needUrl) {
        pre.push(`const url = new URL(req.url);`);
      }

      if (route.usage.query || hasQueryValidator) {
        if (hasQueryValidator) {
          pre.push(`const query = parseQueryFromURL(req.url);`);
          pre.push(`if (!${validatorImportName(route, "query")}(query)) {
  throw validationError(${validatorImportName(route, "query")}.errors ?? {}, "query");
}`);
        } else {
          pre.push(`const query = url.searchParams;`);
        }
      }

      if (route.usage.headers || hasHeadersValidator) {
        if (hasHeadersValidator) {
          pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);
          pre.push(`if (!${validatorImportName(route, "headers")}(__headers)) {
  throw validationError(${validatorImportName(route, "headers")}.errors ?? {}, "headers");
}`);
        }
      }

      if (route.usage.body || hasBodyValidator) {
        pre.push(`let body = createLazyBody(req, BODY_LIMITS);`);

        if (hasBodyValidator) {
          pre.push(`const __body = await body.json();`);
          pre.push(`if (!${validatorImportName(route, "body")}(__body)) {
  throw validationError(${validatorImportName(route, "body")}.errors ?? {}, "body");
}`);
          pre.push(`body.json = async () => __body;`);
        }
      }

      if (route.usage.state) {
        pre.push(`const state = new Map();`);
      }

      pre.push(`const __set = { headers: Object.create(null), cookie: Object.create(null) };`);

      if (route.usage.cookie) {
        pre.push(`const __cookieJar = createCookieJar(__set, {}, parseCookieString(req.headers.get("cookie")));`);
      }

      const props: string[] = [];
      props.push(`set: __set`);

      if (route.usage.params || hasParamsValidator) {
        props.push(`params: __params`);
      }

      if (route.usage.body || hasBodyValidator) {
        props.push(`body`);
      }

      if (route.usage.query || hasQueryValidator) {
        props.push(`query`);
      }

      if (route.usage.headers || hasHeadersValidator) {
        props.push(`headers: req.headers`);
      }

      if (route.usage.req) {
        props.push(`req`);
      }

      if (route.usage.url) {
        props.push(`url`);
      }

      if (route.usage.server) {
        props.push(`server`);
      }

      if (route.usage.state) {
        props.push(`state`);
        props.push(`getState: (key) => state.get(key)`);
        props.push(`setState: (key, value) => { state.set(key, value); }`);
      }

      if (route.usage.json) props.push(`json: jsonReply`);
      if (route.usage.text) props.push(`text: textReply`);
      if (route.usage.html) props.push(`html: htmlReply`);
      if (route.usage.stream) props.push(`stream: streamReply`);
      if (route.usage.redirect) props.push(`redirect: redirectReply`);
      if (route.usage.empty) props.push(`empty: emptyReply`);
      if (route.usage.status) props.push(`status: statusReply`);

      if (route.usage.sendFile) {
        props.push(`sendFile: (path, opts) => sendFile(path, { req, ...opts })`);
      }

      if (route.usage.cookie) {
        props.push(`cookie: __cookieJar`);
      }

      if (route.usage.proxy) {
        props.push(`proxy: (target, opts) => proxyRequest(target, { req, ...opts })`);
      }

      if (route.usage.forward) {
        props.push(`forward: (target, opts) => forwardRequest(req, target, opts)`);
      }

      callExpr =
        props.length === 0
          ? `${handlerImportName(route)}({})`
          : `${handlerImportName(route)}({ ${props.join(", ")} })`;
    }

    const serializersVar = route.serializers?.json
      ? `{ "200": ${route.serializers.json} }`
      : "undefined";

    const routeHookVar = route.hooks.length > 0
      ? `[${route.hooks.map(hookIdent).join(", ")}]`
      : `[]`;

    const coreFn = `async function ${coreName}(req, params, server) {
  let ctx;
  try {
    ${pre.join("\n")}
    ${needsFull ? `
    const gBefore = await __runHooks(__lc.beforeHandle ?? __lc.onRequest, ctx);
    ctx = gBefore.ctx ?? ctx;
    if (gBefore.response) return __applySet(gBefore.response, ctx.set);

    const rBefore = await __runHooks(${routeHookVar}, ctx);
    ctx = rBefore.ctx ?? ctx;
    if (rBefore.response) return __applySet(rBefore.response, ctx.set);
    ` : ""}
    const result = await ${callExpr};
    let response = __finalize(result, ${needsFull ? "ctx" : "{ set: __set }"}, ${serializersVar}, ${routeReplyFn(route)});
    ${needsFull ? `
    const after = await __runHooks(__lc.afterHandle ?? __lc.onResponse, ctx, response);
    ctx = after.ctx ?? ctx;
    response = after.response ?? response;
    return __applySet(response, ctx.set);
    ` : `return __applySet(response, __set);`}
  } catch (err) {
    return __handleError(err, ${needsFull ? "ctx" : "undefined"});
  }
}`;

    functions.push(finalizerCode);

    if (cacheConfig) {
      cacheDecls.push(`const ${cacheVar(route)} = new HttpResponseCache(${JSON.stringify({
        max: 1000,
        ...cacheConfig,
      })});`);

      functions.push(`function ${methodHandlerName(route)}(req, params, server) {
  return ${cacheVar(route)}.getOrSet(req, () => ${coreName}(req, params, server), ${JSON.stringify(
        cacheConfig
      )});
}`);
    } else {
      functions.push(coreFn);
    }
  };

  // =========================================================================
  // Route Table Generation — Bun 1.4 native router with __wrap/__head/OPTIONS
  // =========================================================================

  const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const allowRegExp = (path: string): string => {
    const pattern = path
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) return "[^/]+";
        if (segment.startsWith("*")) return ".*";
        return escapeRegExp(segment);
      })
      .join("/");

    return `^${pattern}$`;
  };

  const BUN_ALL_METHODS = [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ];

  const routeEntries = new Map<string, Map<string, string>>();
  const explicitKeys = new Set<string>();
  const allowMethodsByPattern = new Map<string, Set<string>>();
  const wildcardsByPath = new Map<string, string[]>();

  const addAllowed = (method: string, path: string) => {
    const set = allowMethodsByPattern.get(path) ?? new Set<string>();
    set.add(method);
    allowMethodsByPattern.set(path, set);
  };

const addRouteEntry = (method: string, path: string, expr: string) => {
    if (!routeEntries.has(path)) {
      routeEntries.set(path, new Map());
    }
    const methods = routeEntries.get(path)!;
    if (!methods.has(method)) {
      methods.set(method, expr);
    }
    addAllowed(method, path);
  };

  // First pass: collect explicit keys
  for (const route of routes) {
    generateRouteCode(route);

    const path = bunRoutePath(route.path);
    wildcardsByPath.set(path, wildcardNames(route.path));

    if (route.method === "ALL") {
      for (const method of BUN_ALL_METHODS) {
        explicitKeys.add(`${method} ${path}`);
      }
    } else {
      explicitKeys.add(`${route.method} ${path}`);
    }
  }

  // Second pass: emit explicit routes wrapped with __wrap for error handling
  for (const route of routes) {
    const path = bunRoutePath(route.path);
    const wildcards = JSON.stringify(wildcardNames(route.path));

    if (route.method === "ALL") {
      for (const method of BUN_ALL_METHODS) {
        addRouteEntry(method, path, `__wrap(${methodHandlerName(route)}, ${wildcards})`);
      }
    } else {
      addRouteEntry(route.method, path, `__wrap(${methodHandlerName(route)}, ${wildcards})`);
    }
  }

  // Third pass: automatic HEAD for GET routes
  for (const route of routes) {
    if (route.method !== "GET" && route.method !== "ALL") continue;

    const path = bunRoutePath(route.path);
    const wildcards = JSON.stringify(wildcardNames(route.path));
    const headKey = `HEAD ${path}`;

    if (!explicitKeys.has(headKey)) {
      addRouteEntry("HEAD", path, `__head(${methodHandlerName(route)}, ${wildcards})`);
    }
  }

  // Fourth pass: automatic OPTIONS handlers for CORS preflight
  for (const path of allowMethodsByPattern.keys()) {
    const key = `OPTIONS ${path}`;
    const wildcards = JSON.stringify(wildcardsByPath.get(path) ?? []);

    if (!explicitKeys.has(key)) {
      addRouteEntry("OPTIONS", path, `__wrap(__optionsHandler, ${wildcards})`);
    }
  }

  // Build the __allowed array for 405 responses
  const allowedArray = [...allowMethodsByPattern.entries()].map(([path, set]) => {
    return `{ re: new RegExp(${JSON.stringify(allowRegExp(path))}), allow: ${JSON.stringify(
      [...set].join(",")
    )} }`;
  });

const routeLines: string[] = [];
for (const [path, methods] of routeEntries) {
  if (methods.size === 1) {
    const [method, expr] = [...methods.entries()][0]!;
    routeLines.push(`  ${JSON.stringify(path)}: { ${method}: ${expr} },`);
  } else {
    const methodEntries = [...methods.entries()]
      .map(([m, e]) => `    ${m}: ${e},`)
      .join("\n");
    routeLines.push(`  ${JSON.stringify(path)}: {\n${methodEntries}\n  },`);
  }
}
functions.push(`const __routes = {\n${routeLines.join("\n")}\n};`);

  // Emit allowed-methods lookup for 405
  functions.push(`const __allowed = [${allowedArray.join(",")}];`);

  functions.push(`function __allowFor(pathname) {
  for (const entry of __allowed) {
    if (entry.re.test(pathname)) return entry.allow;
  }
  return undefined;
}`);

  // Emit fallback handler for unmatched routes
  functions.push(`async function __fallback(req, server) {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return __wrap(__optionsHandler, [])(req, undefined, server);
  }

  const allow = __allowFor(url.pathname);

  if (allow) {
    return new Response(JSON.stringify({ error: "Method Not Allowed", status: 405, code: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        Allow: allow,
      },
    });
  }

  return new Response(JSON.stringify({ error: "Not Found", status: 404, code: "NOT_FOUND" }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}`);

  // Emit server bootstrap
  functions.push(`const __serveOptions = {
  port: Number(process.env.PORT ?? __serverCfg.port ?? 3000),
  hostname: __serverCfg.hostname,
  reusePort: ${cfg.reusePort ? "true" : "(__serverCfg.reusePort ?? false)"},
  maxRequestBodySize: __serverCfg.maxRequestBodySize ?? ${opts.maxRequestBodySize ?? 128 * 1024 * 1024},
  routes: __routes,
  fetch: __fallback,
};`);

  functions.push(`if (__serverCfg.websocket) __serveOptions.websocket = __serverCfg.websocket;`);
  functions.push(`if (__serverCfg.idleTimeout) __serveOptions.idleTimeout = __serverCfg.idleTimeout;`);

  functions.push(`const __server = Bun.serve(__serveOptions);`);

  functions.push(`console.log(${JSON.stringify(cfg.serviceName)} + " listening on http://" + (__server.hostname || "localhost") + ":" + __server.port);`);

  functions.push(`export default __server;`);

  return [
    Array.from(imports).join("\n"),
    header.join("\n\n"),
    cacheDecls.join("\n\n"),
    functions.join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const runCodeGen = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("codegen", () => generateServer(routes, modules, hooks, opts));
