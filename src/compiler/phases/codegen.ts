/**
 * @fileoverview Phase 4: CODE GENERATION — BUN NATIVE PERFORMANCE MODE
 *
 * Output strategy:
 * - Use Bun.serve({ routes }) native router.
 * - Use method-specific route objects where possible.
 * - Use static Response objects for constant routes where possible.
 * - Avoid context allocation unless required.
 * - Avoid URL/query/body parsing unless required.
 * - Add tracing/lifecycle only when enabled.
 */
import { fnv1a } from "../utils/hash";
import type {
  RouteDef,
  ModuleInfo,
  SegNode,
  JumpTable,
  CompilerOptions,
  HookDef,
} from "../types";

import type { Logger } from "../logger";
import { join, dirname, relative } from "path";

// ============================================================================
// Config
// ============================================================================




interface CodegenConfig {
  tracing: boolean;
  accessLog: boolean;
  traceHeaders: boolean;
  lifecycle: boolean;
  strictMethods: boolean;
  fastBody: boolean;
  serviceName: string;
  requestIdHeader: string;
  exposeErrorDetails: boolean;
}

const getConfig = (opts: CompilerOptions): CodegenConfig => {
  const tracing = opts.enableTracing ?? true;

  return {
    tracing,
    accessLog: opts.enableAccessLog ?? tracing,
    traceHeaders: opts.enableTraceHeaders ?? tracing,
    lifecycle: opts.enableLifecycle ?? true,
    strictMethods: opts.enableStrictMethods ?? true,
    fastBody: opts.enableFastBodyParsing ?? false,
    serviceName: opts.serviceName ?? "flux",
    requestIdHeader: (opts.requestIdHeader ?? "x-request-id").toLowerCase(),
    exposeErrorDetails: opts.exposeErrorDetails ?? false,
  };
};

// ============================================================================
// Naming Helpers
// ============================================================================

const normalizeImportPath = (p: string): string => {
  let s = p
    .replace(/\\/g, "/")
    .replace(/\.(ts|tsx|js|mjs|jsx)$/, "");

  if (!s.startsWith(".")) {
    s = "./" + s;
  }

  return s;
};

const hookIdent = (name: string): string =>
  `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

const handlerImportName = (route: RouteDef): string =>
  `handler_${route.handlerRef}`;

const methodHandlerName = (route: RouteDef): string =>
  `${route.method}_${route.handlerRef}`;

const finalizeName = (route: RouteDef): string =>
  `finalize_${route.handlerRef}`;

const pathHandlerName = (path: string): string =>
  `route_path_${path
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "root"
  }`;

const constantBodyVar = (route: RouteDef): string =>
  `BODY_${route.handlerRef}`;

const constantInitVar = (route: RouteDef): string =>
  `INIT_${route.handlerRef}`;

const staticResponseVar = (route: RouteDef): string =>
  `STATIC_${route.handlerRef}`;

const hooksArrayVar = (route: RouteDef): string =>
  `HOOKS_${route.handlerRef}`;



// ============================================================================
// Route Analysis Helpers
// ============================================================================

const tryNormalizeConstant = (route: RouteDef): string | null => {
  if (!route.isConstantResponse || !route.constantResponse) return null;
  if (route.hooks.length > 0) return null;

  try {
    JSON.parse(route.constantResponse);
    return route.constantResponse;
  } catch {
    // Continue.
  }

  try {
    const expr = route.constantResponse
      .replace(/^return\s+/, "")
      .replace(/;\s*$/, "")
      .trim();

    const value = new Function(`"use strict"; return (${expr});`)();
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const needsRequestBody = (route: RouteDef): boolean =>
  route.usage.body &&
  route.method !== "GET" &&
  route.method !== "HEAD" &&
  route.method !== "OPTIONS";

const needsFileBody = (route: RouteDef): boolean =>
  route.usage.file && needsRequestBody(route);

const routeReplyFn = (route: RouteDef): string => {
  if (route.responseType === "text") return "textReply";
  if (route.responseType === "html") return "htmlReply";
  if (route.responseType === "stream") return "streamReply";
  return "jsonReply";
};

const validHookNames = (
  route: RouteDef,
  hooks: ReadonlyMap<string, HookDef>
): string[] => route.hooks.filter((name) => hooks.has(name));

// ============================================================================
// Finalizer Generation
// ============================================================================

const generateFinalizer = (route: RouteDef): string => {
  const reply = routeReplyFn(route);

  return `function ${finalizeName(route)}(result) {
  if (result instanceof Response) return result;
  return ${reply}(result);
}`;
};

// ============================================================================
// Method Handler Generation
// ============================================================================

const generateMethodHandler = (
  route: RouteDef,
  constantJson: string | null,
  cfg: CodegenConfig,
  hooks: ReadonlyMap<string, HookDef>
): string => {
  const name = methodHandlerName(route);

  const finish = (expr: string): string =>
    cfg.tracing ? `finishTrace(req, trace, ${expr})` : expr;

  const finishErr = (expr: string): string =>
    cfg.tracing
      ? `finishTraceError(req, trace, ${expr})`
      : `errorResponse(${expr})`;

  // Constant response handler.
  if (constantJson !== null) {
    const traceLine = cfg.tracing ? "const trace = startTrace(req);" : "";
    const responseExpr = `new Response(${constantBodyVar(route)}, ${constantInitVar(route)})`;

    return `function ${name}(req) {
  ${traceLine}
  return ${cfg.tracing ? finish(responseExpr) : responseExpr};
}`;
  }

  const hookNames = validHookNames(route, hooks);
  const hasHooks = cfg.lifecycle && hookNames.length > 0;

  const body = needsRequestBody(route);
  const file = needsFileBody(route);

  const isAsync = route.isAsync || body || file || hasHooks;

  const pre: string[] = [];

  if (cfg.tracing) {
    pre.push("const trace = startTrace(req);");
  }

  if (route.usage.url || route.usage.query) {
    pre.push("const url = new URL(req.url);");
  }

  if (route.usage.query) {
    pre.push("const query = url.searchParams;");
  }

  const usesBody = needsRequestBody(route) || route.usage.file;

  if (usesBody) {
    pre.push("const body = createLazyBody(req, BODY_LIMITS);");
  }

  if (route.usage.state) {
    pre.push("const state = new Map();");
  }

  if (hasHooks) {
    pre.push(
      `const ctx = createFluxContext(req, req.params ?? EMPTY_PARAMS, ${route.usage.query ? "query" : "undefined"
      });`
    );

    if (body) {
      pre.push("ctx.body = body;");
    }

    pre.push(`const halted = await runHooks(${hooksArrayVar(route)}, ctx);`);
    pre.push(`if (halted) return ${finish("halted")};`);
  }

  const minimalCallExpr = (): string => {
    const props: string[] = [];

    if (route.usage.params) {
      props.push("params: req.params ?? EMPTY_PARAMS");
    }

    if (route.usage.body && body) {
      props.push("body");
    }

    if (route.usage.query) {
      props.push("query");
    }

    if (route.usage.body || route.usage.file) {
      props.push("body");
    }

    if (route.usage.headers) {
      props.push("headers: req.headers");
    }

    if (route.usage.req) {
      props.push("req");
    }

    if (route.usage.url) {
      props.push("url");
    }

    if (route.usage.state) {
      props.push("state");
      props.push("getState: (key) => state.get(key)");
      props.push("setState: (key, value) => { state.set(key, value); }");
    }

    if (route.usage.json) {
      props.push("json: jsonReply");
    }

    if (route.usage.text) {
      props.push("text: textReply");
    }

    if (route.usage.redirect) {
      props.push("redirect: redirectReply");
    }

    if (route.responseType === "html") {
      props.push("html: htmlReply");
    }

    if (route.responseType === "stream") {
      props.push("stream: streamReply");
    }

    if (props.length === 0) {
      return `${handlerImportName(route)}()`;
    }

    return `${handlerImportName(route)}({ ${props.join(", ")} })`;
  };

  const callExpr = hasHooks
    ? `${handlerImportName(route)}(ctx)`
    : minimalCallExpr();

  if (isAsync) {
    pre.push(`const result = await ${callExpr};`);
    pre.push(`return ${finish(`${finalizeName(route)}(result)`)};`);

    return `async function ${name}(req) {
  try {
    ${pre.join("\n    ")}
  } catch (err) {
    return ${finishErr("err")};
  }
}`;
  }

  // Sync fast path with promise escape hatch.
  const lines = [...pre];

  lines.push(`const result = ${callExpr};`);
  lines.push(`if (result instanceof Response) return ${finish("result")};`);
  lines.push(
    `if (result && typeof result.then === "function") {
      return result
        .then((v) => ${finish(`${finalizeName(route)}(v)`)})
        .catch((err) => ${finishErr("err")});
    }`
  );
  lines.push(`return ${finish(`${finalizeName(route)}(result)`)};`);

  return `function ${name}(req) {
  try {
    ${lines.join("\n    ")}
  } catch (err) {
    return ${finishErr("err")};
  }
}`;
};

// ============================================================================
// Main Server Generation
// ============================================================================

export const generateServer = (
  routes: readonly RouteDef[],
  _trie: SegNode,
  _jumpTable: JumpTable,
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  _buffers: ReadonlyMap<string, string>,
  opts: CompilerOptions
): string => {
  const cfg = getConfig(opts);
  const BODY_LIMITS = JSON.stringify({
    maxJsonBytes: opts.maxJsonBytes ?? 2 * 1024 * 1024,
    maxTextBytes: opts.maxTextBytes ?? 2 * 1024 * 1024,
    maxFormBytes: opts.maxFormBytes ?? 2 * 1024 * 1024,
    maxFileBytes: opts.maxFileBytes ?? 20 * 1024 * 1024,
  });

  const fromDir = dirname(join(process.cwd(), opts.outDir, opts.outFile));

  const toImportPath = (absPath: string): string =>
    normalizeImportPath(relative(fromDir, absPath));

  const runtimeImport = (projectPath: string): string =>
    toImportPath(join(process.cwd(), projectPath));

  // -------------------------------------------------------------------------
  // Constants / route grouping
  // -------------------------------------------------------------------------

  const constantMap = new Map<string, string | null>();

  for (const route of routes) {
    constantMap.set(route.handlerRef, tryNormalizeConstant(route));
  }

  const groups = new Map<string, RouteDef[]>();

  for (const route of routes) {
    const arr = groups.get(route.path) ?? [];
    arr.push(route);
    groups.set(route.path, arr);
  }

  const staticRouteRefs = new Set<string>();

  for (const group of groups.values()) {
    if (!cfg.strictMethods && !cfg.tracing && group.length === 1) {
      const route = group[0]!;

      if (
        (route.method === "GET" || route.method === "ALL") &&
        constantMap.get(route.handlerRef) !== null
      ) {
        staticRouteRefs.add(route.handlerRef);
      }
    }
  }

  const nonConstantRoutes = routes.filter(
    (r) => constantMap.get(r.handlerRef) === null
  );

  const anyNonConstant = nonConstantRoutes.length > 0;

  const anyBody = nonConstantRoutes.some(
    (r) => needsRequestBody(r) && !needsFileBody(r)
  );

  const anyFile = nonConstantRoutes.some((r) => needsFileBody(r));

  const anyHooks =
    cfg.lifecycle &&
    routes.some((r) => validHookNames(r, hooks).length > 0);

  const anyJson =
    anyNonConstant ||
    anyHooks ||
    nonConstantRoutes.some((r) => r.responseType === "json" || r.usage.json);

  const anyText =
    anyHooks ||
    nonConstantRoutes.some((r) => r.responseType === "text" || r.usage.text);

  const anyHtml =
    anyHooks || nonConstantRoutes.some((r) => r.responseType === "html");

  const anyStream =
    anyHooks || nonConstantRoutes.some((r) => r.responseType === "stream");

  const anyRedirect =
    anyHooks || nonConstantRoutes.some((r) => r.usage.redirect);

  // -------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------

  const handlerImports = nonConstantRoutes
    .map((route) => {
      const mod = modules[route.moduleIdx];

      if (!mod) return "";

      return `import { default as ${handlerImportName(
        route
      )} } from "${toImportPath(mod.path)}";`;
    })
    .filter((s) => s.length > 0)
    .join("\n");

  const missingStubs = nonConstantRoutes
    .filter((route) => !modules[route.moduleIdx])
    .map((route) => {
      return `function ${handlerImportName(route)}() {
  throw new Error(${JSON.stringify(`Missing module for ${route.file}`)});
}`;
    })
    .join("\n");

  const hookImports = anyHooks
    ? Array.from(hooks.values())
      .map((h) => {
        const abs = join(process.cwd(), h.source);

        return `import { default as ${hookIdent(
          h.name
        )} } from "${toImportPath(abs)}";`;
      })
      .join("\n")
    : "";

  // -------------------------------------------------------------------------
  // Runtime constants
  // -------------------------------------------------------------------------

  const baseConstants = `const HDR_JSON = { "content-type": "application/json; charset=utf-8" };
const JSON_INIT = { headers: HDR_JSON };
const BODY_LIMITS = ${BODY_LIMITS};
const NOT_FOUND_BODY = '{"error":"Not Found"}';
const NOT_FOUND_INIT = { status: 404, headers: HDR_JSON };

const METHOD_NOT_ALLOWED_BODY = '{"error":"Method Not Allowed"}';
const METHOD_NOT_ALLOWED_INIT = { status: 405, headers: HDR_JSON };

const INTERNAL_ERROR_BODY = '{"error":"Internal Server Error"}';
const INTERNAL_ERROR_INIT = { status: 500, headers: HDR_JSON };

const EMPTY_PARAMS = Object.freeze({});

const SERVICE = ${JSON.stringify(cfg.serviceName)};
const REQUEST_ID_HEADER = ${JSON.stringify(cfg.requestIdHeader)};
const ACCESS_LOG = ${cfg.accessLog};
const TRACE_HEADERS = ${cfg.traceHeaders};
const EXPOSE_ERRORS = ${cfg.exposeErrorDetails};

const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
};`;

  const constantLines: string[] = [];

  for (const route of routes) {
    const json = constantMap.get(route.handlerRef);

    if (json == null) continue;

    constantLines.push(
      `const ${constantBodyVar(route)} = ${JSON.stringify(json)};`
    );

    constantLines.push(
      `const ${constantInitVar(route)} = { status: 200, headers: HDR_JSON };`
    );

    if (staticRouteRefs.has(route.handlerRef)) {
      constantLines.push(
        `const ${staticResponseVar(route)} = new Response(${constantBodyVar(
          route
        )}, ${constantInitVar(route)});`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Runtime helpers
  // -------------------------------------------------------------------------

  const helpers: string[] = [];

  helpers.push(`function notFound() {
  return new Response(NOT_FOUND_BODY, NOT_FOUND_INIT);
}`);

  helpers.push(`function methodNotAllowed() {
  return new Response(METHOD_NOT_ALLOWED_BODY, METHOD_NOT_ALLOWED_INIT);
}`);

  helpers.push(`function errorResponse(err, traceId) {
  const status = err && typeof err.status === "number" ? err.status : 500;

  const message =
    EXPOSE_ERRORS && err instanceof Error
      ? err.message
      : STATUS_TEXT[status] || "Error";

  const payload = { error: message, status };

  if (traceId) payload.traceId = traceId;

  return Response.json(payload, { status });
}`);

  if (anyJson || anyHooks) {
    helpers.push(`function jsonReply(data, init) {
  if (!init) return Response.json(data, JSON_INIT);

  const headers = new Headers(HDR_JSON);

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return Response.json(data, {
    status: init.status ?? 200,
    headers,
  });
}`);
  }

  if (anyText || anyHooks) {
    helpers.push(`const HDR_TEXT = { "content-type": "text/plain; charset=utf-8" };
const TEXT_INIT = { headers: HDR_TEXT };

function textReply(data, init) {
  const body = typeof data === "string" ? data : JSON.stringify(data);

  if (!init) return new Response(body, TEXT_INIT);

  const headers = new Headers(HDR_TEXT);

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return new Response(body, {
    status: init.status ?? 200,
    headers,
  });
}`);
  }

  if (anyHtml || anyHooks) {
    helpers.push(`const HDR_HTML = { "content-type": "text/html; charset=utf-8" };
const HTML_INIT = { headers: HDR_HTML };

function htmlReply(data, init) {
  const body = typeof data === "string" ? data : JSON.stringify(data);

  if (!init) return new Response(body, HTML_INIT);

  const headers = new Headers(HDR_HTML);

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return new Response(body, {
    status: init.status ?? 200,
    headers,
  });
}`);
  }

  if (anyStream || anyHooks) {
    helpers.push(`function streamReply(stream, init) {
  return new Response(stream, init);
}`);
  }

  if (anyRedirect || anyHooks) {
    helpers.push(`function redirectReply(location, status = 302) {
  return Response.redirect(location, status);
}`);
  }

  if (anyHooks) {
    helpers.push(`function emptyReply(status = 204) {
  return new Response(null, { status });
}`);
  }

  if (cfg.tracing || anyHooks) {
    helpers.push(`let requestIdSeq = 0;

function getRequestId(req) {
  const header = req.headers.get(REQUEST_ID_HEADER);

  if (header) return header;

  return Bun.nanoseconds().toString(36) + "-" + (++requestIdSeq).toString(36);
}`);
  }

  if (cfg.accessLog) {
    helpers.push(`function getPath(u) {
  if (u.charCodeAt(0) === 47) {
    const q = u.indexOf("?");
    return q === -1 ? u : u.slice(0, q);
  }

  const start = u.indexOf("/", 8);

  if (start === -1) return "/";

  const q = u.indexOf("?", start);

  return q === -1 ? u.slice(start) : u.slice(start, q);
}`);
  }

  if (cfg.tracing) {
    helpers.push(`function startTrace(req) {
  return {
    id: getRequestId(req),
    start: performance.now(),
  };
}`);

    helpers.push(`function finishTrace(req, trace, response) {
  const duration = performance.now() - trace.start;

  if (TRACE_HEADERS) {
    try {
      response.headers.set(REQUEST_ID_HEADER, trace.id);
      response.headers.set("x-response-time", duration.toFixed(3));
    } catch {
      // Some responses may have immutable headers.
    }
  }

  if (ACCESS_LOG) {
    const level =
      response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info";

    console.log(
      JSON.stringify({
        level,
        service: SERVICE,
        traceId: trace.id,
        method: req.method,
        path: getPath(req.url),
        status: response.status,
        durationMs: Math.round(duration * 1000) / 1000,
      })
    );
  }

  return response;
}`);

    helpers.push(`function finishTraceError(req, trace, err) {
  const response = errorResponse(err, trace.id);
  const duration = performance.now() - trace.start;

  if (TRACE_HEADERS) {
    try {
      response.headers.set(REQUEST_ID_HEADER, trace.id);
      response.headers.set("x-response-time", duration.toFixed(3));
    } catch {
      // Ignore immutable header failures.
    }
  }

  if (ACCESS_LOG) {
    console.error(
      JSON.stringify({
        level: "error",
        service: SERVICE,
        traceId: trace.id,
        method: req.method,
        path: getPath(req.url),
        status: response.status,
        durationMs: Math.round(duration * 1000) / 1000,
        error: EXPOSE_ERRORS && err instanceof Error ? err.message : undefined,
      })
    );
  }

  return response;
}`);
  }

  if (anyBody && cfg.fastBody) {
    helpers.push(`async function parseJsonBody(req) {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}`);
  }

  if (anyBody && !cfg.fastBody) {
    helpers.push(`async function parseRequestBody(req) {
  const ct = req.headers.get("content-type") || "";

  if (ct.includes("application/json")) {
    try {
      return await req.json();
    } catch {
      return undefined;
    }
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return Object.fromEntries(new URLSearchParams(text));
  }

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const obj = {};

    for (const [key, value] of form) {
      obj[key] = value;
    }

    return obj;
  }

  return undefined;
}`);
  }

  if (anyFile) {
    helpers.push(`async function parseMultipartBody(req) {
  const form = await req.formData();
  const obj = {};

  for (const [key, value] of form) {
    obj[key] = value;
  }

  return obj;
}`);
  }

  if (anyHooks) {
    helpers.push(`function createFluxContext(req, params, query) {
  const url = new URL(req.url);
  const state = new Map();

  return {
    req,
    url,
    method: req.method,
    path: url.pathname,
    headers: req.headers,
    requestId: getRequestId(req),
    startTime: performance.now(),
    params: params ?? EMPTY_PARAMS,
    query: query ?? url.searchParams,
    body: undefined,
    state,
    get: (key) => state.get(key),
    set: (key, value) => {
      state.set(key, value);
    },
    json: jsonReply,
    text: textReply,
    html: htmlReply,
    redirect: redirectReply,
    stream: streamReply,
    empty: emptyReply,
  };
}`);

    helpers.push(`async function runHooks(hooks, ctx) {
  let current = ctx;

  for (const hook of hooks) {
    const result = await hook(current);

    if (result instanceof Response) return result;

    if (result && result.ok === false && result.response) {
      return result.response;
    }

    if (result && result.ctx) {
      current = result.ctx;
    }
  }

  return null;
}`);
  }

  helpers.push(
    cfg.tracing
      ? `function fetchHandler(req) {
  const trace = startTrace(req);
  return finishTrace(req, trace, notFound());
}`
      : `function fetchHandler(req) {
  return notFound();
}`
  );

  // -------------------------------------------------------------------------
  // Finalizers
  // -------------------------------------------------------------------------

  const finalizers = routes
    .filter(
      (r) =>
        !staticRouteRefs.has(r.handlerRef) &&
        constantMap.get(r.handlerRef) === null
    )
    .map((r) => generateFinalizer(r));

  // -------------------------------------------------------------------------
  // Hook arrays
  // -------------------------------------------------------------------------

  const hookArrays = routes
    .filter((r) => validHookNames(r, hooks).length > 0)
    .map((r) => {
      const names = validHookNames(r, hooks).map(hookIdent);
      return `const ${hooksArrayVar(r)} = [${names.join(", ")}];`;
    });

  // -------------------------------------------------------------------------
  // Method handlers
  // -------------------------------------------------------------------------

  const methodHandlers = routes
    .filter((r) => !staticRouteRefs.has(r.handlerRef))
    .map((r) =>
      generateMethodHandler(
        r,
        constantMap.get(r.handlerRef) ?? null,
        cfg,
        hooks
      )
    );

  // -------------------------------------------------------------------------
  // Route object generation
  // -------------------------------------------------------------------------

  const routeEntries: string[] = [];
  const pathHandlers: string[] = [];

  for (const [path, group] of groups.entries()) {
    const hasAll = group.some((r) => r.method === "ALL");

    // Zero-allocation static route where safe.
    if (
      !cfg.strictMethods &&
      !cfg.tracing &&
      group.length === 1 &&
      (group[0]!.method === "GET" || group[0]!.method === "ALL") &&
      constantMap.get(group[0]!.handlerRef) !== null
    ) {
      routeEntries.push(
        `${JSON.stringify(path)}: ${staticResponseVar(group[0]!)}`
      );
      continue;
    }

    // Direct ALL handler.
    if (!cfg.strictMethods && hasAll && group.length === 1) {
      routeEntries.push(
        `${JSON.stringify(path)}: ${methodHandlerName(group[0]!)}`
      );
      continue;
    }

    // Method-specific route object where possible.
    if (!cfg.strictMethods && !hasAll) {
      const methodMap = group
        .map((r) => `${r.method}: ${methodHandlerName(r)}`)
        .join(", ");

      routeEntries.push(`${JSON.stringify(path)}: { ${methodMap} }`);
      continue;
    }

    // Fallback: path-level method switch for strict 405 or ALL mixing.
    const phName = pathHandlerName(path);

    const cases = group
      .filter((r) => r.method !== "ALL")
      .map((r) => {
        return `case ${JSON.stringify(r.method)}: return ${methodHandlerName(
          r
        )}(req);`;
      })
      .join("\n    ");

    const allRoute = group.find((r) => r.method === "ALL");

    const defaultCase = allRoute
      ? `return ${methodHandlerName(allRoute)}(req);`
      : cfg.strictMethods
        ? `return methodNotAllowed();`
        : `return notFound();`;

    pathHandlers.push(`function ${phName}(req) {
  switch (req.method) {
    ${cases}
    default: ${defaultCase}
  }
}`);

    routeEntries.push(`${JSON.stringify(path)}: ${phName}`);
  }

  const routesObject = `const routes = {
  ${routeEntries.join(",\n  ")}
};`;

  // -------------------------------------------------------------------------
  // Server output
  // -------------------------------------------------------------------------

const clusterMode = JSON.stringify(opts.cluster ?? 1);
const reusePort = JSON.stringify(opts.reusePort ?? false);

const serverBootstrap = `
const WORKER_SETTING = ${clusterMode};

const SERVER_OPTIONS = {
  port: Number(process.env.PORT || 3000),
  hostname: process.env.HOSTNAME || "0.0.0.0",
  routes,
  development: false,
  maxRequestBodySize: ${JSON.stringify(
    opts.maxFileBytes ?? 20 * 1024 * 1024
  )},
  idleTimeout: 30,
};

const WORKER_COUNT =
  WORKER_SETTING === "auto"
    ? Math.max(1, navigator.hardwareConcurrency || 1)
    : Math.max(1, Number(WORKER_SETTING || 1));

const servers = [];

for (let i = 0; i < WORKER_COUNT; i++) {
  servers.push(
    Bun.serve({
      ...SERVER_OPTIONS,
      reusePort: WORKER_COUNT > 1 ? true : ${reusePort},
    })
  );
}

process.on("SIGTERM", () => {
  for (const server of servers) server.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  for (const server of servers) server.stop();
  process.exit(0);
});

export default servers[0];
`;

  return [
    handlerImports,
    missingStubs,
    hookImports,
    baseConstants,
    constantLines.join("\n"),
    helpers.join("\n\n"),
    finalizers.join("\n\n"),
    hookArrays.join("\n"),
    methodHandlers.join("\n\n"),
    pathHandlers.join("\n\n"),
    routesObject,
    serverBootstrap
  ]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
};

// ============================================================================
// Phase Orchestrator
// ============================================================================

export const runCodeGen = (
  routes: readonly RouteDef[],
  trie: SegNode,
  jumpTable: JumpTable,
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  buffers: ReadonlyMap<string, string>,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("codegen", () => {
    const code = generateServer(
      routes,
      trie,
      jumpTable,
      modules,
      hooks,
      buffers,
      opts
    );

    logger.info(
      `Generated ${code.split("\n").length} lines of Bun-native server code`
    );

    return code;
  });