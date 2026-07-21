/**
 * Flux AOT Code Generator — Bun 1.4 native router edition.
 *
 * Emits Bun.serve({ routes }) instead of custom regex/trie runtime matching.
 */

import { join, relative } from "path";

import type {
  RouteDef,
  ModuleInfo,
  CompilerOptions,
  HookDef,
} from "../types";

import type { Logger } from "../logger";

interface CodegenConfig {
  target: "bun" | "node" | "deno";
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

  const corePath = runtimeImport("src/core/index.ts", opts);

  imports.add(
    `import { createContext, createLazyBody, parseQueryFromURL, errorToResponse, sendFile, HttpResponseCache, ValidationError } from ${JSON.stringify(
      corePath
    )};`
  );

  for (const route of routes) {
    const mod = modules[route.moduleIdx];

    if (mod) {
      imports.add(
        `import ${handlerImportName(route)} from ${JSON.stringify(
          toImportPath(mod.path, opts)
        )};`
      );
    }

    if (route.validators) {
      const kinds = ["body", "query", "params", "headers"] as const;

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

    const needsFull =
      !cfg.specializeContext ||
      hasHooks ||
      route.usage.cookie ||
      route.usage.set ||
      route.usage.proxy ||
      route.usage.forward ||
      route.usage.cache ||
      (mod ? FORCE_FULL_TOKENS.some((token) => mod.content.includes(token)) : false);

    const hasBodyValidator = !!route.validators?.body;
    const hasQueryValidator = !!route.validators?.query;
    const hasParamsValidator = !!route.validators?.params;
    const hasHeadersValidator = !!route.validators?.headers;

    const serializer = route.serializers?.json;

    const cacheConfig = getCacheConfig(route, cfg);
    const coreName = coreHandlerName(route, !!cacheConfig);

    const finalizerCode = `function ${finalizeName(route)}(result) {
  if (result instanceof Response) return result;
  if (result === undefined) return new Response(null, { status: 204 });
  ${
    serializer
      ? `return new Response(${serializer}(result), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });`
      : `return ${routeReplyFn(route)}(result);`
  }
}`;

    const pre: string[] = [];
    let callExpr = "";

    if (needsFull) {
      pre.push(`let ctx = createContext(req, params ?? EMPTY_PARAMS, { body: BODY_LIMITS });`);
      pre.push(`ctx.server = server;`);

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

      if (hasParamsValidator) {
        pre.push(`if (!${validatorImportName(route, "params")}(ctx.params)) {
  throw validationError(${validatorImportName(route, "params")}.errors ?? {}, "params");
}`);
      }

      if (hasQueryValidator) {
        pre.push(`const __query = parseQueryFromURL(req.url);`);
        pre.push(`if (!${validatorImportName(route, "query")}(__query)) {
  throw validationError(${validatorImportName(route, "query")}.errors ?? {}, "query");
}`);
      }

      if (hasHeadersValidator) {
        pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);
        pre.push(`if (!${validatorImportName(route, "headers")}(__headers)) {
  throw validationError(${validatorImportName(route, "headers")}.errors ?? {}, "headers");
}`);
      }

      if (hasBodyValidator) {
        pre.push(`const __body = await ctx.body.json();`);
        pre.push(`if (!${validatorImportName(route, "body")}(__body)) {
  throw validationError(${validatorImportName(route, "body")}.errors ?? {}, "body");
}`);
        pre.push(`ctx.body.json = async () => __body;`);
      }

      callExpr = `${handlerImportName(route)}(ctx)`;
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

      const props: string[] = [];

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

      callExpr =
        props.length === 0
          ? `${handlerImportName(route)}({})`
          : `${handlerImportName(route)}({ ${props.join(", ")} })`;
    }

    const coreFn = `async function ${coreName}(req, params, server) {
  try {
    ${pre.join("\n    ")}
    const result = await ${callExpr};
    return ${finalizeName(route)}(result);
  } catch (err) {
    return errorToResponse(err, EXPOSE_ERRORS);
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

  for (const route of routes) {
    generateRouteCode(route);
  }

  const byPath = new Map<string, RouteDef[]>();

  for (const route of routes) {
    const existing = byPath.get(route.path);

    if (existing) {
      existing.push(route);
    } else {
      byPath.set(route.path, [route]);
    }
  }

  const routeEntries: string[] = [];

  for (const [path, defs] of byPath.entries()) {
    const cases: string[] = [];

    let defaultCase = `return methodNotAllowed();`;

    for (const def of defs) {
      const handler = methodHandlerName(def);
      const wildcards = wildcardNames(def.path);

      const paramsExpr =
        wildcards.length > 0
          ? `{ ...__params, ${wildcards
              .map(
                (name) =>
                  `...(__params["*"] !== undefined ? { ${JSON.stringify(
                    name
                  )}: __params["*"] } : {})`
              )
              .join(", ")} }`
          : `__params`;

      if (def.method === "ALL") {
        defaultCase = `return ${handler}(req, ${paramsExpr}, __server);`;
      } else {
        cases.push(
          `case ${JSON.stringify(
            def.method
          )}: return ${handler}(req, ${paramsExpr}, __server);`
        );
      }
    }

    routeEntries.push(`  ${JSON.stringify(bunRoutePath(path))}: (req, params) => {
    const __params = params ?? req.params ?? EMPTY_PARAMS;

    switch (req.method) {
      ${cases.join("\n      ")}
      default: ${defaultCase}
    }
  }`);
  }

  const routesObject = `const ROUTES = {
${routeEntries.join(",\n")}
};`;

  const server = `let __server = null;

const notFound = () =>
  new Response(
    JSON.stringify({ error: "Not Found", status: 404, code: "NOT_FOUND" }),
    {
      status: 404,
      headers: { "content-type": "application/json" },
    }
  );

const methodNotAllowed = () =>
  new Response(
    JSON.stringify({ error: "Method Not Allowed", status: 405, code: "METHOD_NOT_ALLOWED" }),
    {
      status: 405,
      headers: { "content-type": "application/json" },
    }
  );

__server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  reusePort: ${cfg.reusePort ? "true" : "false"},
  routes: ROUTES,
  fetch: () => notFound(),
});

console.log("flux server listening on http://localhost:" + __server.port);`;

  return [
    Array.from(imports).join("\n"),
    header.join("\n\n"),
    cacheDecls.join("\n\n"),
    functions.join("\n\n"),
    routesObject,
    server,
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
