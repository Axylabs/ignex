/**
 * Flux AOT Code Generator — Bun 1.4 native router edition.
 *
 * Emits Bun.serve({ routes }) instead of custom regex/trie runtime matching.
 *
 * Output is assembled through an indentation-aware {@link Emitter} and runtime
 * boilerplate helpers are emitted only when actually referenced by a route
 * (dead-code elimination of generated helpers).
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { Emitter } from "../emitter";
import type { CompilerContext, CompilerOptions, HookDef, ModuleInfo, RouteDef } from "../types";
import { handlerBodyReferencesImports, isPlainJavaScriptBody, parseModule } from "../utils/ast";
import { projectPath } from "../utils/path";

interface CodegenConfig {
  target: "bun";
  tracing: boolean;
  lifecycle: boolean;
  serviceName: string;
  exposeErrorDetails: boolean;
  specializeContext: boolean;
  reusePort: boolean;
  routeCache: boolean;
  treeshakeRuntime: boolean;
  hoistConstants: boolean;
  maxInlineBytes: number;
  inlineThreshold: number;
  enableTraceHeaders: boolean;
  enableAccessLog: boolean;
}

const getConfig = (opts: CompilerOptions): CodegenConfig => ({
  target: opts.target,
  tracing: opts.enableTracing ?? false,
  lifecycle: opts.enableLifecycle ?? true,
  serviceName: opts.serviceName ?? "flux",
  exposeErrorDetails: opts.exposeErrorDetails ?? false,
  specializeContext: opts.specializeContext ?? true,
  reusePort: opts.reusePort ?? false,
  routeCache: opts.routeCache ?? true,
  treeshakeRuntime: opts.treeshakeRuntime ?? true,
  hoistConstants: opts.hoistConstants ?? true,
  maxInlineBytes: opts.maxInlineBytes ?? 2048,
  inlineThreshold: opts.inlineThreshold ?? 50,
  enableTraceHeaders: opts.enableTraceHeaders ?? false,
  enableAccessLog: opts.enableAccessLog ?? false,
});

const toImportPath = (absPath: string, opts: CompilerOptions): string => {
  let rel = relative(opts.outDir, absPath)
    .replace(/\\/g, "/")
    .replace(/\.(ts|tsx|js|mjs|jsx)$/, "");

  if (!rel.startsWith(".")) rel = `./${rel}`;

  return rel;
};

const handlerImportName = (route: RouteDef): string => `handler_${route.handlerRef}`;

const methodHandlerName = (route: RouteDef): string => `${route.method}_${route.handlerRef}`;

const constantBodyVar = (route: RouteDef): string => `BODY_${route.handlerRef}`;

const constantInitVar = (route: RouteDef): string => `INIT_${route.handlerRef}`;

const hookIdent = (name: string): string => `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

const cacheVar = (route: RouteDef): string => `CACHE_${route.handlerRef}`;

const coreHandlerName = (route: RouteDef, hasCache: boolean): string =>
  hasCache ? `core_${route.handlerRef}` : methodHandlerName(route);

const validatorImportName = (route: RouteDef, kind: string): string =>
  `validate_${route.handlerRef}_${kind}`;

const serializerImportName = (route: RouteDef, status: string): string =>
  `serialize_${route.handlerRef}_${status}`;

const routeReplyFn = (route: RouteDef): string => {
  if (route.responseType === "text") return "textReply";
  if (route.responseType === "html") return "htmlReply";
  if (route.responseType === "stream") return "streamReply";
  return "jsonReply";
};

const tryNormalizeConstant = (route: RouteDef, hasGlobalHooks: boolean): string | null => {
  if (!route.isConstantResponse || !route.constantResponse) return null;
  // Hoisting to a frozen Response bypasses the whole lifecycle (plugins,
  // hooks, ctx.set, error handling). Only hoist when we can prove at compile
  // time that there is nothing to bypass.
  if (hasGlobalHooks) return null;
  if (route.hooks.length > 0) return null;
  if (route.hasValidation) return null;

  if (route.validators && Object.keys(route.validators).length > 0) {
    return null;
  }

  // `constantResponse` was produced by a JSON.stringify round-trip during
  // analysis, so it is already valid JSON — no re-parse required.
  return route.constantResponse;
};

const getCacheConfig = (
  route: RouteDef,
  cfg: CodegenConfig,
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

const wildcardNames = (path: string): string[] =>
  Array.from(path.matchAll(/\*([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);

// ---------------------------------------------------------------------------
// Runtime helper registry — dependency-aware pruning of generated boilerplate.
// `deps` lists other generated helpers a helper references; `core` lists
// `@flux/core` symbols a helper needs. Only helpers (and their transitive
// deps/core imports) that are actually referenced end up in the output.
// ---------------------------------------------------------------------------

interface HelperDef {
  readonly deps: readonly string[];
  readonly core: readonly string[];
}

const HELPERS: Record<string, HelperDef> = {
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
const resolveUsedHelpers = (e: Emitter): ReadonlySet<string> => {
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
const HELPER_SOURCES: Record<string, string> = {
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
  __wrap: `function __wrap(handler, wildcards = []) {
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
}`,
  __head: `function __head(handler, wildcards = []) {
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
const indentBody = (body: string): string =>
  body
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");

/**
 * Transpile a handler body from TS to plain JS so it can be safely inlined
 * into the generated `.js` server. Returns `null` when the body cannot be
 * made into safe JS — inlining is then skipped and the handler is imported
 * (and TS-transpiled by the runtime/bundler) instead.
 *
 * When `Bun.Transpiler` is unavailable (e.g. vitest workers), falls back to a
 * plain-JavaScript parse check: only bodies that are already plain JS are
 * inlined raw.
 */
const transpileHandlerBody = (body: string, isAsync: boolean): string | null => {
  const bun = (
    globalThis as {
      Bun?: {
        Transpiler?: new (opts: { loader: string }) => { transformSync(code: string): string };
      };
    }
  ).Bun;

  if (bun?.Transpiler) {
    try {
      const t = new bun.Transpiler({ loader: "ts" });
      // Wrap so top-level `return` / `await` are legal, then extract the inner
      // body from the transpiled (type-erased) function.
      const wrapped = t.transformSync(
        `${isAsync ? "async " : ""}function __fluxInline() { ${body} }`,
      );
      const start = wrapped.indexOf("{");
      const end = wrapped.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      return wrapped.slice(start + 1, end).trim();
    } catch {
      // fall through to the plain-JS check
    }
  }

  if (isPlainJavaScriptBody(body, isAsync)) return body;
  return null;
};

/**
 * A handler can be inlined (instead of imported) when its module is fully
 * self-contained: no imports the body references, no other top-level symbols,
 * a simple identifier parameter, a body under `maxInlineBytes`, and marked
 * eligible by the optimization phase (`shouldInline`). The body is transpiled
 * to plain JS so TS-only syntax never leaks into the generated server.
 */
const getInlineCandidate = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  opts: CompilerOptions,
): { body: string; isAsync: boolean; param: string } | null => {
  if (!route.shouldInline) return null;
  if (!mod) return null;
  // Imports referenced by the handler body would be dropped when inlined;
  // imports that only feed the wrapper call / type-only imports are fine.
  if (handlerBodyReferencesImports(mod)) return null;

  // The named-export handler's own symbol is fine; any OTHER top-level symbol
  // means the module is not fully self-contained.
  const selfName = route.handlerExportName;
  const otherSymbols = selfName ? mod.symbols.filter((s) => s.name !== selfName) : mod.symbols;
  if (otherSymbols.length > 0) return null;

  const parsed = parseModule(mod.content);
  const handler = parsed.handler;
  if (!handler?.body || !handler.isSimpleParam) return null;
  if (handler.body.length > (opts.maxInlineBytes ?? 2048)) return null;

  const body = transpileHandlerBody(handler.body, handler.isAsync);
  if (body === null) return null;

  return {
    body,
    isAsync: handler.isAsync,
    param: handler.paramName,
  };
};

export const generateServer = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
): string => {
  const cfg = getConfig(opts);

  const imports = new Set<string>();
  const header: string[] = [];
  const cacheDecls: string[] = [];
  const functions: string[] = [];
  const helpers = new Emitter();

  const corePath = "@flux/core";

  const appConfigPath = opts.appConfig;
  const appConfigAbs = appConfigPath ? projectPath(appConfigPath) : undefined;
  const hasAppConfig =
    typeof appConfigPath === "string" &&
    appConfigPath.length > 0 &&
    (appConfigAbs ? existsSync(appConfigAbs) : false);

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
    "runHooks",
  ];

  if (hasAppConfig) {
    coreNames.push(
      "createPluginContext",
      "mergeLifeCycle",
      "pluginsToLifeCycle",
      "pluginContextToLifecycle",
    );
  }

  for (const route of routes) {
    if (route.usage.proxy) coreNames.push("proxyRequest");
    if (route.usage.forward) coreNames.push("forwardRequest");
  }

  const uniqueCore = [...new Set(coreNames)].sort();

  if (hasAppConfig && appConfigAbs) {
    imports.add(
      `import * as __appConfig from ${JSON.stringify(toImportPath(appConfigAbs, opts))};`,
    );
  }

  // Handlers from fully self-contained modules are inlined instead of
  // imported, producing a more self-contained server entry.
  const inlineHandlers = new Map<string, { body: string; isAsync: boolean; param: string }>();

  for (const route of routes) {
    const mod = modules[route.moduleIdx];
    const inline = getInlineCandidate(route, mod, opts);
    if (inline) inlineHandlers.set(route.handlerRef, inline);

    if (mod && !inlineHandlers.has(route.handlerRef)) {
      const named = route.handlerExportName;
      const spec = named ? `{ ${named} as ${handlerImportName(route)} }` : handlerImportName(route);
      imports.add(`import ${spec} from ${JSON.stringify(toImportPath(mod.path, opts))};`);
      if (route.hasValidation) {
        imports.add(
          `import * as schema_${route.handlerRef} from ${JSON.stringify(
            toImportPath(mod.path, opts),
          )};`,
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
              kind,
            )} from "./validators/${route.handlerRef}.${kind}.cjs";`,
          );
        }
      }
    }

    if (route.serializers?.byStatus) {
      for (const [status, importName] of Object.entries(route.serializers.byStatus)) {
        imports.add(`import ${importName} from "./serializers/${route.handlerRef}.${status}.mjs";`);
      }
    } else if (route.serializers?.json) {
      imports.add(
        `import ${serializerImportName(route, "200")} from "./serializers/${route.handlerRef}.200.mjs";`,
      );
    }

    for (const hookName of route.hooks) {
      const hook = hooks.get(hookName);

      if (hook) {
        imports.add(
          `import ${hookIdent(hookName)} from ${JSON.stringify(toImportPath(hook.source, opts))};`,
        );
      }
    }
  }

  // ---- Header constants (always emitted) --------------------------------
  header.push(`const EMPTY_PARAMS = Object.freeze({});`);

  header.push(`const __EMPTY_SET = Object.freeze({ headers: Object.freeze({}) });`);

  header.push(`const BODY_LIMITS = Object.freeze({
  maxJsonBytes: ${opts.maxJsonBytes ?? 2 * 1024 * 1024},
  maxTextBytes: ${opts.maxTextBytes ?? 2 * 1024 * 1024},
  maxFormBytes: ${opts.maxFormBytes ?? 2 * 1024 * 1024},
  maxFileBytes: ${opts.maxFileBytes ?? 20 * 1024 * 1024},
});`);

  header.push(`const EXPOSE_ERRORS = ${cfg.exposeErrorDetails ? "true" : "false"};`);
  header.push(`const __TRACE = ${cfg.enableTraceHeaders ? "true" : "false"};`);
  header.push(`const __ACCESS_LOG = ${cfg.enableAccessLog ? "true" : "false"};`);

  if (hasAppConfig) {
    header.push(`const __pluginContext = createPluginContext();`);
    header.push(`for (const __p of __appConfig.plugins ?? []) {
  if (typeof __p === "function") await __p(__pluginContext);
  else if (__p && typeof __p.setup === "function") await __p.setup(__pluginContext);
  else if (__p && typeof __p.init === "function") await __p.init();
}`);
    header.push(
      `const __pluginLC = mergeLifeCycle(pluginContextToLifecycle(__pluginContext), pluginsToLifeCycle(__appConfig.plugins ?? []));`,
    );
    header.push(`const __userLC = __appConfig.lifecycle ?? __appConfig.hooks ?? {};`);
    header.push(
      `const __lc = mergeLifeCycle(mergeLifeCycle(EMPTY_LIFECYCLE, __pluginLC), __userLC);`,
    );
    header.push(`const __serverCfg = __appConfig.server ?? {};`);
  } else {
    header.push(`const __lc = EMPTY_LIFECYCLE;`);
    header.push(`const __serverCfg = {};`);
  }

  // Prebuilt lifecycle stage chains — composed once, not per request.
  header.push(`const __preParseStages = [...__lc.start, ...__lc.request, ...__lc.parse, ...__lc.transform];
const __preStages = [...__lc.start, ...__lc.request, ...__lc.parse, ...__lc.transform, ...__lc.beforeHandle];
const __postStages = [...__lc.afterHandle, ...__lc.mapResponse];
const __hasPreStages = __preStages.length > 0;
const __hasPostStages = __postStages.length > 0;
const __hasAfterResponse = (__lc.afterResponse ?? []).length > 0;`);

  // ---- Emit inlined handlers before route handlers ----------------------
  for (const [ref, inline] of inlineHandlers) {
    functions.push(`// Inlined route handler (self-contained module)
const handler_${ref} = ${inline.isAsync ? "async " : ""}(${inline.param}) => {
${indentBody(inline.body)}
};`);
  }

  const generateRouteCode = (route: RouteDef): void => {
    // Deduplicated (non-leader) routes reuse the leader's handler; only the
    // leader emits it.
    if (route.dedupGroup) return;

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

    const hasHooks = route.hooks.length > 0;

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
      route.hasValidation ||
      route.usage.cookie ||
      route.usage.set ||
      route.usage.proxy ||
      route.usage.forward ||
      route.usage.cache ||
      route.usage.loader ||
      route.usage.sendFile ||
      route.usage.file;

    const hasParamsValidator = !!route.validators?.params;
    const hasQueryValidator = !!route.validators?.query;
    const hasHeadersValidator = !!route.validators?.headers;
    const hasBodyValidator = !!route.validators?.body;
    const hasCookieValidator = !!route.validators?.cookie;

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
      pre.push(`let ctx = createContext(req, params ?? EMPTY_PARAMS, { body: BODY_LIMITS });`);
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
        route.hasValidation ||
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
            route.hasValidation ? `__schemaFor(schema_${route.handlerRef})` : `undefined`
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

      const needUrl = route.usage.url || (route.usage.query && !hasQueryValidator);

      if (needUrl) {
        pre.push(`const url = new URL(req.url);`);
      }

      if (route.usage.query || hasQueryValidator) {
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

      if (route.usage.headers || hasHeadersValidator) {
        if (hasHeadersValidator) {
          helpers.markUsed("validationError");
          pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);
          pre.push(`if (!${validatorImportName(route, "headers")}(__headers)) {
  throw validationError(${validatorImportName(route, "headers")}.errors ?? {}, "headers");
}`);
        }
      }

      if (route.usage.body || hasBodyValidator) {
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

      if (route.usage.state) {
        pre.push(`const state = new Map();`);
      }

      if (route.usage.set || route.usage.cookie) {
        pre.push(`const __set = { headers: Object.create(null), cookie: Object.create(null) };`);
      } else {
        pre.push(`const __set = __EMPTY_SET;`);
      }

      if (route.usage.cookie) {
        helpers.markCore("createCookieJar");
        helpers.markCore("parseCookieString");
        pre.push(
          `const __cookieJar = createCookieJar(__set, {}, parseCookieString(req.headers.get("cookie")));`,
        );
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

      if (route.usage.json) {
        helpers.markUsed("jsonReply");
        props.push(`json: jsonReply`);
      }
      if (route.usage.text) {
        helpers.markUsed("textReply");
        props.push(`text: textReply`);
      }
      if (route.usage.html) {
        helpers.markUsed("htmlReply");
        props.push(`html: htmlReply`);
      }
      if (route.usage.stream) {
        helpers.markUsed("streamReply");
        props.push(`stream: streamReply`);
      }
      if (route.usage.redirect) {
        helpers.markUsed("redirectReply");
        props.push(`redirect: redirectReply`);
      }
      if (route.usage.empty) {
        helpers.markUsed("emptyReply");
        props.push(`empty: emptyReply`);
      }
      if (route.usage.status) {
        helpers.markUsed("statusReply");
        props.push(`status: statusReply`);
      }

      if (route.usage.sendFile) {
        helpers.markCore("sendFile");
        props.push(`sendFile: (path, opts) => sendFile(path, { req, ...opts })`);
      }

      if (route.usage.cookie) {
        props.push(`cookie: __cookieJar`);
      }

      if (route.usage.proxy) {
        helpers.markCore("proxyRequest");
        props.push(`proxy: (target, opts) => proxyRequest(target, { req, ...opts })`);
      }

      if (route.usage.forward) {
        helpers.markCore("forwardRequest");
        props.push(`forward: (target, opts) => forwardRequest(req, target, opts)`);
      }

      callExpr =
        props.length === 0
          ? `${handlerImportName(route)}({})`
          : `${handlerImportName(route)}({ ${props.join(", ")} })`;
    }

    const serializersVar = route.serializers?.byStatus
      ? `{ ${Object.entries(route.serializers.byStatus)
          .map(([s, n]) => `${JSON.stringify(s)}: ${n}`)
          .join(", ")} }`
      : route.serializers?.json
        ? `{ "200": ${route.serializers.json} }`
        : "undefined";

    const routeHookVar =
      route.hooks.length > 0 ? `[${route.hooks.map(hookIdent).join(", ")}]` : `[]`;

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
    await runHooks(__lc.afterResponse, ctx, response);
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

  // =========================================================================
  // Route Table Generation — Bun 1.4 native router with __wrap/__head/OPTIONS
  // =========================================================================

  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  const BUN_ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

  /** Handler name used in the route table, honoring deduplication. */
  const routeHandlerName = (route: RouteDef): string =>
    route.dedupGroup ? `${route.method}_${route.dedupGroup}` : methodHandlerName(route);

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

    const path = route.path;
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
    helpers.markUsed("__wrap");

    const path = route.path;
    const wildcards = JSON.stringify(wildcardNames(route.path));
    const handler = routeHandlerName(route);

    if (route.method === "ALL") {
      for (const method of BUN_ALL_METHODS) {
        addRouteEntry(method, path, `__wrap(${handler}, ${wildcards})`);
      }
    } else {
      addRouteEntry(route.method, path, `__wrap(${handler}, ${wildcards})`);
    }
  }

  // Third pass: automatic HEAD for GET routes
  for (const route of routes) {
    if (route.method !== "GET" && route.method !== "ALL") continue;

    const path = route.path;
    const wildcards = JSON.stringify(wildcardNames(route.path));
    const headKey = `HEAD ${path}`;

    if (!explicitKeys.has(headKey)) {
      helpers.markUsed("__head");
      addRouteEntry("HEAD", path, `__head(${routeHandlerName(route)}, ${wildcards})`);
    }
  }

  // Fourth pass: automatic OPTIONS handlers for CORS preflight
  for (const path of allowMethodsByPattern.keys()) {
    const key = `OPTIONS ${path}`;
    const wildcards = JSON.stringify(wildcardsByPath.get(path) ?? []);

    if (!explicitKeys.has(key)) {
      helpers.markUsed("__optionsHandler");
      addRouteEntry("OPTIONS", path, `__wrap(__optionsHandler, ${wildcards})`);
    }
  }

  // Build the __allowed lookup for 405 responses. Static paths get an O(1)
  // object lookup; only dynamic patterns (with :params or *wildcards) need a
  // regex scan, so the hot 404/405 path avoids scanning every route.
  const allowedStatic: string[] = [];
  const allowedDynamic: string[] = [];

  for (const [path, set] of allowMethodsByPattern.entries()) {
    const allow = JSON.stringify([...set].join(","));
    const entry = `{ re: new RegExp(${JSON.stringify(allowRegExp(path))}), allow: ${allow} }`;

    if (path.includes(":") || path.includes("*")) {
      allowedDynamic.push(entry);
    } else {
      allowedStatic.push(`${JSON.stringify(path)}: ${allow}`);
    }
  }

  const routeLines: string[] = [];
  for (const [path, methods] of routeEntries) {
    if (methods.size === 1) {
      const [method, expr] = [...methods.entries()][0]!;
      routeLines.push(`  ${JSON.stringify(path)}: { ${method}: ${expr} },`);
    } else {
      const methodEntries = [...methods.entries()].map(([m, e]) => `    ${m}: ${e},`).join("\n");
      routeLines.push(`  ${JSON.stringify(path)}: {\n${methodEntries}\n  },`);
    }
  }
  functions.push(`const __routes = {\n${routeLines.join("\n")}\n};`);

  // Emit allowed-methods lookup for 405 (__allowFor / __fallback are helpers).
  functions.push(`const __allowedStatic = Object.freeze({ ${allowedStatic.join(", ")} });`);
  functions.push(`const __allowedDynamic = [${allowedDynamic.join(",")}];`);
  helpers.markUsed("__allowFor");
  helpers.markUsed("__fallback");

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
  functions.push(
    `if (__serverCfg.idleTimeout) __serveOptions.idleTimeout = __serverCfg.idleTimeout;`,
  );

  functions.push(`const __server = Bun.serve(__serveOptions);`);

  functions.push(
    `console.log(${JSON.stringify(cfg.serviceName)} + " listening on http://" + (__server.hostname || "localhost") + ":" + __server.port);`,
  );

  functions.push(`export default __server;`);

  // ---- Emit runtime helpers (pruned to what is actually referenced) ------
  const usedHelpers = resolveUsedHelpers(helpers);

  // Prune the `@flux/core` import to only the symbols the emitted code
  // actually references: header-required symbols, per-route core deps
  // (markCore), and the transitive core deps of used generated helpers.
  const neededCore = new Set<string>(["EMPTY_LIFECYCLE"]);
  if (hasAppConfig) {
    neededCore.add("createPluginContext");
    neededCore.add("mergeLifeCycle");
    neededCore.add("pluginsToLifeCycle");
    neededCore.add("pluginContextToLifecycle");
  }
  for (const name of uniqueCore) {
    if (helpers.isCoreUsed(name)) neededCore.add(name);
  }
  for (const name of usedHelpers) {
    for (const dep of HELPERS[name]?.core ?? []) neededCore.add(dep);
  }
  const coreImport = `import { ${[...neededCore].sort().join(", ")} } from ${JSON.stringify(
    corePath,
  )};`;

  const helperBlock = Object.keys(HELPERS)
    .filter((name) => (cfg.treeshakeRuntime ? usedHelpers.has(name) : true))
    .map((name) => HELPER_SOURCES[name])
    .join("\n\n");

  return [
    coreImport,
    Array.from(imports).join("\n"),
    header.join("\n\n"),
    "// ===== Generated runtime helpers =====",
    helperBlock,
    cacheDecls.join("\n\n"),
    "// ===== Route handlers =====",
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
  ctx: CompilerContext,
): string => ctx.logger.time("codegen", () => generateServer(routes, modules, hooks, opts));
