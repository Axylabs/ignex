/**
 * Flux AOT Code Generator — Phase 2
 *
 * Adds:
 * - precompiled validator wiring
 * - serializer wiring
 * - radix-style dynamic router
 * - compiled hook chains
 * - route-level cache emission
 */

import { dirname, join, relative } from "path";

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

interface RouteInfo {
  route: RouteDef;
  mod?: ModuleInfo;
  constantJson: string | null;
  hookNames: string[];
  hasHooks: boolean;
  needsFull: boolean;
  needsBody: boolean;
  minimalBody: boolean;
  minimalSendFile: boolean;

  hasBodyValidator: boolean;
  hasQueryValidator: boolean;
  hasParamsValidator: boolean;
  hasHeadersValidator: boolean;

  hasSerializer: boolean;
  cacheConfig?: {
    ttlMs?: number;
    staleTtlMs?: number;
    vary?: string[];
  };
}

interface DynamicRouteInfo {
  method: string;
  regexLiteral: string;
  paramNames: string[];
  handlerName: string;
  segmentCount: number;
  hasWildcard: boolean;
  path: string;
}

interface TrieNode {
  static: Map<string, TrieNode>;
  param?: { name: string; node: TrieNode };
  wildcard?: { name: string; node: TrieNode };
  handlers: Map<string, string>;
}

const getConfig = (opts: CompilerOptions): CodegenConfig => ({
  target: opts.target,
  tracing: opts.enableTracing ?? false,
  lifecycle: opts.enableLifecycle ?? true,
  serviceName: opts.serviceName ?? "flux",
  exposeErrorDetails: opts.exposeErrorDetails ?? false,
  specializeContext: opts.specializeContext ?? true,
  reusePort: opts.reusePort ?? false,
  router: opts.router ?? "auto",
  inlineHooks: opts.inlineHooks ?? true,
  routeCache: opts.routeCache ?? true,
});

const normalizeImportPath = (p: string): string => {
  let s = p.replace(/\\/g, "/").replace(/\.(ts|tsx|js|mjs|jsx)$/, "");
  if (!s.startsWith(".")) s = "./" + s;
  return s;
};

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

const hooksChainName = (route: RouteDef): string =>
  `hooks_${route.handlerRef}`;

const cacheVar = (route: RouteDef): string =>
  `CACHE_${route.handlerRef}`;

const coreHandlerName = (route: RouteDef, hasCache: boolean): string =>
  hasCache ? `core_${route.handlerRef}` : methodHandlerName(route);

const validatorImportName = (route: RouteDef, kind: string): string =>
  `validate_${route.handlerRef}_${kind}`;

const validatorImportPath = (route: RouteDef, kind: string): string =>
  `./validators/${route.handlerRef}.${kind}.cjs`;

const serializerImportName = (route: RouteDef): string =>
  `serialize_${route.handlerRef}`;

const serializerImportPath = (route: RouteDef): string =>
  `./serializers/${route.handlerRef}.200.mjs`;

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

const validHookNames = (
  route: RouteDef,
  hooks: ReadonlyMap<string, HookDef>
): string[] => route.hooks.filter((name) => hooks.has(name));

const routeReplyFn = (route: RouteDef): string => {
  if (route.responseType === "text") return "textReply";
  if (route.responseType === "html") return "htmlReply";
  if (route.responseType === "stream") return "streamReply";
  return "jsonReply";
};

const FORCE_FULL_TOKENS = [
  "ctx.cookie",
  "ctx.server",
  "ctx.set",
  "ctx.proxy",
  "ctx.forward",
  "ctx.cache",
];

const needsFullContext = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  cfg: CodegenConfig,
  hasHooks: boolean
): boolean => {
  if (!cfg.specializeContext) return true;
  if (hasHooks) return true;

  if (
    route.usage.cookie ||
    route.usage.set ||
    route.usage.proxy ||
    route.usage.forward ||
    route.usage.cache
  ) {
    return true;
  }

  if (mod && FORCE_FULL_TOKENS.some((token) => mod.content.includes(token))) {
    return true;
  }

  return false;
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

const generateHookChain = (info: RouteInfo): string => {
  const route = info.route;

  const calls = info.hookNames
    .map((name) => {
      const ident = hookIdent(name);

      return `  r = await ${ident}(ctx);
  if (r instanceof Response) return r;
  if (r && typeof r === "object" && r.ok === false && r.response instanceof Response) {
    return r.response;
  }`;
    })
    .join("\n\n");

  return `async function ${hooksChainName(route)}(ctx) {
  let r;

${calls}

  return null;
}`;
};

const generateFinalizer = (info: RouteInfo): string => {
  const route = info.route;

  if (info.hasSerializer) {
    return `function ${finalizeName(route)}(result) {
  if (result instanceof Response) return result;
  return new Response(${serializerImportName(route)}(result), INIT_SER_${route.handlerRef});
}`;
  }

  const reply = routeReplyFn(route);

  return `function ${finalizeName(route)}(result) {
  if (result instanceof Response) return result;
  return ${reply}(result);
}`;
};

const generateCoreHandler = (info: RouteInfo, cfg: CodegenConfig): string => {
  const route = info.route;
  const name = coreHandlerName(route, !!info.cacheConfig);

  if (info.constantJson !== null) {
    return `function ${name}(req, params, url, server) {
  return new Response(${constantBodyVar(route)}, ${constantInitVar(route)});
}`;
  }

  const pre: string[] = [];
  let callExpr = "";

  if (info.needsFull) {
    const ctxOpts: string[] = [];

    if (info.needsBody) {
      ctxOpts.push("body: BODY_LIMITS");
    }

    const ctxOptsExpr = ctxOpts.length > 0 ? `, { ${ctxOpts.join(", ")} }` : "";

    pre.push(
      `const ctx = createContext(req, params ?? EMPTY_PARAMS${ctxOptsExpr});`
    );

    if (route.usage.server) {
      pre.push("ctx.server = server;");
    }

    if (info.hasHooks) {
      pre.push(
        `const halted = await ${hooksChainName(route)}(ctx);`
      );
      pre.push("if (halted) return halted;");
    }

    if (info.hasParamsValidator) {
      pre.push(
        `if (!${validatorImportName(route, "params")}(ctx.params)) throw validationError(${validatorImportName(route, "params")}.errors, "params");`
      );
    }

    if (info.hasQueryValidator) {
      pre.push(
        `const __query = parseQuery(ctx.url.search.startsWith("?") ? ctx.url.search.slice(1) : "");`
      );
      pre.push(
        `if (!${validatorImportName(route, "query")}(__query)) throw validationError(${validatorImportName(route, "query")}.errors, "query");`
      );
    }

    if (info.hasHeadersValidator) {
      pre.push(
        `const __headers = Object.fromEntries(ctx.headers.entries());`
      );
      pre.push(
        `if (!${validatorImportName(route, "headers")}(__headers)) throw validationError(${validatorImportName(route, "headers")}.errors, "headers");`
      );
    }

    if (info.hasBodyValidator) {
      pre.push(`const __body = await ctx.body.json();`);
      pre.push(
        `if (!${validatorImportName(route, "body")}(__body)) throw validationError(${validatorImportName(route, "body")}.errors, "body");`
      );
    }

    callExpr = `${handlerImportName(route)}(ctx)`;
  } else {
    if (route.usage.query || info.hasQueryValidator) {
      pre.push("const query = url.searchParams;");
    }

    if (info.minimalBody) {
      pre.push("const body = createLazyBody(req, BODY_LIMITS);");
    }

    if (route.usage.state) {
      pre.push("const state = new Map();");
    }

    if (info.hasParamsValidator) {
      pre.push(
        `if (!${validatorImportName(route, "params")}(params ?? EMPTY_PARAMS)) throw validationError(${validatorImportName(route, "params")}.errors, "params");`
      );
    }

    if (info.hasQueryValidator) {
      pre.push(
        `const __query = parseQuery(url.search.startsWith("?") ? url.search.slice(1) : "");`
      );
      pre.push(
        `if (!${validatorImportName(route, "query")}(__query)) throw validationError(${validatorImportName(route, "query")}.errors, "query");`
      );
    }

    if (info.hasHeadersValidator) {
      pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);
      pre.push(
        `if (!${validatorImportName(route, "headers")}(__headers)) throw validationError(${validatorImportName(route, "headers")}.errors, "headers");`
      );
    }

    let bodyProp = "body";

    if (info.hasBodyValidator && info.minimalBody) {
      pre.push(`const __body = await body.json();`);
      pre.push(
        `if (!${validatorImportName(route, "body")}(__body)) throw validationError(${validatorImportName(route, "body")}.errors, "body");`
      );
      pre.push(`const validatedBody = Object.create(body);`);
      pre.push(`validatedBody.json = async () => __body;`);
      bodyProp = "validatedBody";
    }

    const props: string[] = [];

    if (route.usage.params) {
      props.push("params: params ?? EMPTY_PARAMS");
    }

    if (info.minimalBody) {
      props.push(`body: ${bodyProp}`);
    }

    if (route.usage.query) {
      props.push("query");
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

    if (route.usage.server) {
      props.push("server");
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

    if (route.usage.html) {
      props.push("html: htmlReply");
    }

    if (route.usage.stream) {
      props.push("stream: streamReply");
    }

    if (route.usage.redirect) {
      props.push("redirect: redirectReply");
    }

    if (route.usage.empty) {
      props.push("empty: emptyReply");
    }

    if (route.usage.status) {
      props.push("status: (code) => new Response(null, { status: code })");
    }

    if (info.minimalSendFile) {
      props.push("sendFile: (path, opts) => coreSendFile(path, { req, ...opts })");
    }

    callExpr =
      props.length === 0
        ? `${handlerImportName(route)}({})`
        : `${handlerImportName(route)}({ ${props.join(", ")} })`;
  }

  const isAsync =
    route.isAsync ||
    info.hasHooks ||
    info.needsFull ||
    info.minimalBody ||
    info.hasBodyValidator ||
    !!info.cacheConfig ||
    route.usage.state;

  if (isAsync) {
    return `async function ${name}(req, params, url, server) {
  try {
    ${pre.join("\n    ")}
    const result = await ${callExpr};
    return ${finalizeName(route)}(result);
  } catch (err) {
    return errorResponse(err);
  }
}`;
  }

  return `function ${name}(req, params, url, server) {
  try {
    ${pre.join("\n    ")}
    const result = ${callExpr};
    if (result instanceof Response) return result;
    if (result && typeof result.then === "function") {
      return result
        .then((v) => ${finalizeName(route)}(v))
        .catch((err) => errorResponse(err));
    }
    return ${finalizeName(route)}(result);
  } catch (err) {
    return errorResponse(err);
  }
}`;
};

const generateCacheWrapper = (info: RouteInfo): string | null => {
  if (!info.cacheConfig) return null;

  const route = info.route;
  const opts = JSON.stringify(info.cacheConfig);

  return `function ${methodHandlerName(route)}(req, params, url, server) {
  return ${cacheVar(route)}.getOrSet(req, () => ${coreHandlerName(route, true)}(req, params, url, server), ${opts});
}`;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const routePattern = (
  path: string
): { regexLiteral: string; paramNames: string[] } => {
  const paramNames: string[] = [];
  const segments = path.split("/").filter(Boolean);

  const pattern = segments
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }

      if (seg.startsWith("*")) {
        paramNames.push(seg.slice(1));
        return "(.*)";
      }

      return escapeRegex(seg);
    })
    .join("/");

  const source = segments.length === 0 ? "^/$" : `^/${pattern}$`;
  const regexLiteral = `/${source.replace(/\//g, "\\/")}/`;

  return { regexLiteral, paramNames };
};

const newTrieNode = (): TrieNode => ({
  static: new Map(),
  handlers: new Map(),
});

const insertDynamicRoute = (
  root: TrieNode,
  route: RouteDef,
  handlerName: string
): void => {
  let node = root;

  const segments = route.path.split("/").filter(Boolean);

  for (const seg of segments) {
    if (seg.startsWith(":")) {
      const name = seg.slice(1);

      if (!node.param) {
        node.param = { name, node: newTrieNode() };
      }

      node = node.param.node;
      continue;
    }

    if (seg.startsWith("*")) {
      const name = seg.slice(1);

      if (!node.wildcard) {
        node.wildcard = { name, node: newTrieNode() };
      }

      node = node.wildcard.node;
      continue;
    }

    if (!node.static.has(seg)) {
      node.static.set(seg, newTrieNode());
    }

    node = node.static.get(seg)!;
  }

  node.handlers.set(route.method, handlerName);
};

const emitTrieNode = (node: TrieNode): string => {
  const staticEntries = Array.from(node.static.entries()).map(
    ([seg, child]) => `${JSON.stringify(seg)}: ${emitTrieNode(child)}`
  );

  const param = node.param
    ? `{ name: ${JSON.stringify(node.param.name)}, node: ${emitTrieNode(node.param.node)} }`
    : "null";

  const wildcard = node.wildcard
    ? `{ name: ${JSON.stringify(node.wildcard.name)}, node: ${emitTrieNode(node.wildcard.node)} }`
    : "null";

  const handlerEntries = Array.from(node.handlers.entries()).map(
    ([method, handler]) => `${JSON.stringify(method)}: ${handler}`
  );

  return `{ s: { ${staticEntries.join(", ")} }, p: ${param}, w: ${wildcard}, h: { ${handlerEntries.join(", ")} } }`;
};

export const generateServer = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
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

  const routeInfos: RouteInfo[] = routes.map((route) => {
    const mod = modules[route.moduleIdx];
    const constantJson = tryNormalizeConstant(route);
    const hookNames = validHookNames(route, hooks);
    const hasHooks = cfg.lifecycle && hookNames.length > 0;

    const validators = route.validators ?? {};

    const hasBodyValidator = !!validators.body;
    const hasQueryValidator = !!validators.query;
    const hasParamsValidator = !!validators.params;
    const hasHeadersValidator = !!validators.headers;

    const needsBody =
      route.usage.body || route.usage.file || hasBodyValidator;

    const needsFull = needsFullContext(route, mod, cfg, hasHooks);

    const minimalBody = needsBody && !needsFull;
    const minimalSendFile = route.usage.sendFile && !needsFull;

    const hasSerializer = !!route.serializers?.json;
    const cacheConfig = getCacheConfig(route, cfg);

    return {
      route,
      mod,
      constantJson,
      hookNames,
      hasHooks,
      needsFull,
      needsBody,
      minimalBody,
      minimalSendFile,
      hasBodyValidator,
      hasQueryValidator,
      hasParamsValidator,
      hasHeadersValidator,
      hasSerializer,
      cacheConfig,
    };
  });

  const nonConstantInfos = routeInfos.filter((x) => x.constantJson === null);

  const anyNonConstant = nonConstantInfos.length > 0;
  const anyFullContext = nonConstantInfos.some((x) => x.needsFull);
  const anyLazyBody = nonConstantInfos.some((x) => x.minimalBody);
  const anySendFile = nonConstantInfos.some((x) => x.minimalSendFile);
  const anyHooks = cfg.lifecycle && nonConstantInfos.some((x) => x.hasHooks);
  const anyCache = nonConstantInfos.some((x) => !!x.cacheConfig);

  const anyValidators = nonConstantInfos.some(
    (x) =>
      x.hasBodyValidator ||
      x.hasQueryValidator ||
      x.hasParamsValidator ||
      x.hasHeadersValidator
  );

  const anyQueryValidator = nonConstantInfos.some((x) => x.hasQueryValidator);
  const anySerializers = nonConstantInfos.some((x) => x.hasSerializer);

  const anyJson = anyNonConstant;
  const anyText = nonConstantInfos.some(
    (x) => x.route.usage.text || x.route.responseType === "text"
  );
  const anyHtml = nonConstantInfos.some(
    (x) => x.route.usage.html || x.route.responseType === "html"
  );
  const anyStream = nonConstantInfos.some(
    (x) => x.route.usage.stream || x.route.responseType === "stream"
  );
  const anyRedirect = nonConstantInfos.some((x) => x.route.usage.redirect);
  const anyEmpty = nonConstantInfos.some(
    (x) => x.route.usage.empty || x.route.usage.status
  );

  const handlerImports = Array.from(
    new Set(
      nonConstantInfos
        .map((info) => {
          if (!info.mod) return "";

          return `import { default as ${handlerImportName(
            info.route
          )} } from "${toImportPath(info.mod.path)}";`;
        })
        .filter(Boolean)
    )
  ).join("\n");

  const missingStubs = nonConstantInfos
    .filter((info) => !info.mod)
    .map((info) => {
      return `function ${handlerImportName(info.route)}() {
  throw new Error(${JSON.stringify(`Missing module for ${info.route.file}`)});
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

  const validatorImports = nonConstantInfos
    .flatMap((info) => {
      const route = info.route;
      const imports: string[] = [];

      if (info.hasBodyValidator) {
        imports.push(
          `import ${validatorImportName(route, "body")} from "${validatorImportPath(route, "body")}";`
        );
      }

      if (info.hasQueryValidator) {
        imports.push(
          `import ${validatorImportName(route, "query")} from "${validatorImportPath(route, "query")}";`
        );
      }

      if (info.hasParamsValidator) {
        imports.push(
          `import ${validatorImportName(route, "params")} from "${validatorImportPath(route, "params")}";`
        );
      }

      if (info.hasHeadersValidator) {
        imports.push(
          `import ${validatorImportName(route, "headers")} from "${validatorImportPath(route, "headers")}";`
        );
      }

      return imports;
    })
    .join("\n");

  const serializerImports = nonConstantInfos
    .filter((info) => info.hasSerializer)
    .map((info) => {
      return `import ${serializerImportName(info.route)} from "${serializerImportPath(info.route)}";`;
    })
    .join("\n");

  const coreImports: string[] = [];

  if (anyFullContext) {
    coreImports.push(
      `import { createContext } from "${runtimeImport("src/core/context.ts")}";`
    );
  }

  if (anyLazyBody) {
    coreImports.push(
      `import { createLazyBody } from "${runtimeImport("src/core/body.ts")}";`
    );
  }

  if (anySendFile) {
    coreImports.push(
      `import { sendFile as coreSendFile } from "${runtimeImport(
        "src/core/files.ts"
      )}";`
    );
  }

  if (anyCache) {
    coreImports.push(
      `import { HttpResponseCache } from "${runtimeImport("src/core/cache.ts")}";`
    );
  }

  if (anyQueryValidator) {
    coreImports.push(
      `import { parseQuery } from "${runtimeImport("src/core/query.ts")}";`
    );
  }

  const constants: string[] = [];

  constants.push(`const HDR_JSON = { "content-type": "application/json; charset=utf-8" };`);
  constants.push(`const JSON_INIT = { headers: HDR_JSON };`);
  constants.push(`const BODY_LIMITS = ${BODY_LIMITS};`);
  constants.push(`const EMPTY_PARAMS = Object.freeze({});`);
  constants.push(`const EXPOSE_ERRORS = ${cfg.exposeErrorDetails};`);
  constants.push(`const NOT_FOUND_BODY = '{"error":"Not Found"}';`);
  constants.push(`const NOT_FOUND_INIT = { status: 404, headers: HDR_JSON };`);
  constants.push(`const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
};`);

  for (const info of routeInfos) {
    if (info.constantJson === null) continue;

    constants.push(
      `const ${constantBodyVar(info.route)} = ${JSON.stringify(
        info.constantJson
      )};`
    );

    constants.push(
      `const ${constantInitVar(info.route)} = { status: 200, headers: HDR_JSON };`
    );
  }

  for (const info of nonConstantInfos) {
    if (info.hasSerializer) {
      constants.push(
        `const INIT_SER_${info.route.handlerRef} = { status: 200, headers: HDR_JSON };`
      );
    }

    if (info.cacheConfig) {
      const cacheOpts = JSON.stringify({
        max: 1000,
        ttlMs: info.cacheConfig.ttlMs ?? 60_000,
        staleTtlMs: info.cacheConfig.staleTtlMs ?? 0,
      });

      constants.push(
        `const ${cacheVar(info.route)} = new HttpResponseCache(${cacheOpts});`
      );
    }
  }

  const helpers: string[] = [];

  helpers.push(`function notFound() {
  return new Response(NOT_FOUND_BODY, NOT_FOUND_INIT);
}`);

  helpers.push(`function errorResponse(err) {
  const status = err && typeof err.status === "number" ? err.status : 500;
  const message =
    EXPOSE_ERRORS && err instanceof Error
      ? err.message
      : STATUS_TEXT[status] || "Error";

  return Response.json({ error: message, status }, { status });
}`);

  if (anyValidators) {
    helpers.push(`function validationError(errors, on) {
  const err = new Error("Validation failed");
  err.status = 422;
  err.errors = errors;
  err.on = on;
  return err;
}`);
  }

  if (anyJson) {
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

  if (anyText) {
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

  if (anyHtml) {
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

  if (anyStream) {
    helpers.push(`function streamReply(stream, init) {
  return new Response(stream, init);
}`);
  }

  if (anyRedirect) {
    helpers.push(`function redirectReply(location, status = 302) {
  return Response.redirect(location, status);
}`);
  }

  if (anyEmpty) {
    helpers.push(`function emptyReply(status = 204) {
  return new Response(null, { status });
}`);
  }

  const hookChainFunctions = nonConstantInfos
    .filter((info) => info.hasHooks)
    .map((info) => generateHookChain(info))
    .join("\n\n");

  const finalizers = nonConstantInfos
    .map((info) => generateFinalizer(info))
    .join("\n\n");

  const coreHandlers = routeInfos
    .map((info) => generateCoreHandler(info, cfg))
    .join("\n\n");

  const cacheWrappers = nonConstantInfos
    .map((info) => generateCacheWrapper(info))
    .filter(Boolean)
    .join("\n\n");

  const staticEntries: string[] = [];
  const dynamicInfos: DynamicRouteInfo[] = [];

  for (const info of routeInfos) {
    const handlerName = methodHandlerName(info.route);

    if (info.route.isStatic) {
      staticEntries.push(
        `[${JSON.stringify(`${info.route.method}:${info.route.path}`)}, ${handlerName}]`
      );
      continue;
    }

    const pattern = routePattern(info.route.path);

    dynamicInfos.push({
      method: info.route.method,
      regexLiteral: pattern.regexLiteral,
      paramNames: pattern.paramNames,
      handlerName,
      segmentCount: info.route.segmentCount,
      hasWildcard: info.route.path.includes("*"),
      path: info.route.path,
    });
  }

  dynamicInfos.sort((a, b) => {
    if (a.hasWildcard !== b.hasWildcard) {
      return a.hasWildcard ? 1 : -1;
    }

    if (a.segmentCount !== b.segmentCount) {
      return b.segmentCount - a.segmentCount;
    }

    return a.path.localeCompare(b.path);
  });

  const staticRoutes = `const staticRoutes = new Map([
${staticEntries.join(",\n")}
]);`;

  const dynamicCount = dynamicInfos.length;

  const useRouterRadix =
    cfg.router === "radix" ||
    (cfg.router === "auto" && dynamicCount > 30);

  let dynamicRouterData = "";
  let dynamicMatcher = "";

  if (useRouterRadix) {
    const root = newTrieNode();

    for (const info of routeInfos) {
      if (!info.route.isDynamic) continue;

      insertDynamicRoute(
        root,
        info.route,
        methodHandlerName(info.route)
      );
    }

    dynamicRouterData = `const dynamicTrie = ${emitTrieNode(root)};`;

    dynamicMatcher = `function matchDynamic(method, path) {
  const parts = path === "/" ? [] : path.split("/").slice(1);
  const params = {};

  function walk(node, idx) {
    if (idx === parts.length) {
      const handler = node.h[method] ?? node.h.ALL;
      if (handler) return { handler, params };
      return null;
    }

    const part = parts[idx];

    const staticNode = node.s[part];
    if (staticNode) {
      const res = walk(staticNode, idx + 1);
      if (res) return res;
    }

    if (node.p) {
      const prev = params[node.p.name];
      params[node.p.name] = decodeParam(part);

      const res = walk(node.p.node, idx + 1);
      if (res) return res;

      if (prev === undefined) delete params[node.p.name];
      else params[node.p.name] = prev;
    }

    if (node.w) {
      const prev = params[node.w.name];
      params[node.w.name] = parts.slice(idx).map(decodeParam).join("/");

      const handler = node.w.node.h[method] ?? node.w.node.h.ALL;
      if (handler) return { handler, params };

      if (prev === undefined) delete params[node.w.name];
      else params[node.w.name] = prev;
    }

    return null;
  }

  return walk(dynamicTrie, 0);
}`;
  } else {
    const dynamicRoutes = `const dynamicRoutes = [
${dynamicInfos
        .map(
          (entry) => `  {
    method: ${JSON.stringify(entry.method)},
    pattern: ${entry.regexLiteral},
    paramNames: ${JSON.stringify(entry.paramNames)},
    handler: ${entry.handlerName},
  },`
        )
        .join("\n")}
];`;

    dynamicRouterData = dynamicRoutes;

    dynamicMatcher = `function matchDynamic(method, path) {
  for (const route of dynamicRoutes) {
    if (route.method !== method && route.method !== "ALL") continue;

    const match = route.pattern.exec(path);
    if (!match) continue;

    const params = {};

    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]] = decodeParam(match[i + 1] ?? "");
    }

    return { handler: route.handler, params };
  }

  return null;
}`;
  }

  const router = `function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

${dynamicMatcher}

function routerFetch(req, server) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  let handler = staticRoutes.get(method + ":" + path);

  if (!handler) {
    handler = staticRoutes.get("ALL:" + path);
  }

  if (!handler && method === "HEAD") {
    handler = staticRoutes.get("GET:" + path);
  }

  if (handler) {
    return handler(req, EMPTY_PARAMS, url, server);
  }

  const match = matchDynamic(method, path);

  if (match) {
    return match.handler(req, match.params, url, server);
  }

  return notFound();
}`;

  const serverBootstrap =
    cfg.target === "bun"
      ? `if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);

  const server = Bun.serve({
    port,
    fetch: routerFetch,
    reusePort: ${cfg.reusePort},
  });

  console.log(${JSON.stringify(cfg.serviceName)} + " listening on " + server.url);
}`
      : `// Node/Deno target: export fetch handler only.`;

  return [
    handlerImports,
    hookImports,
    validatorImports,
    serializerImports,
    coreImports.join("\n"),
    missingStubs,
    constants.join("\n"),
    helpers.join("\n\n"),
    hookChainFunctions,
    finalizers,
    coreHandlers,
    cacheWrappers,
    staticRoutes,
    dynamicRouterData,
    router,
    serverBootstrap,
    `export { routerFetch as fetch };`,
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
