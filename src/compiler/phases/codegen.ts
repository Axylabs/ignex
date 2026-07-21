/**
 * Flux AOT Code Generator
 *
 * Goals:
 * - prebake constant responses
 * - emit static route map
 * - emit sorted dynamic matcher
 * - specialize context per route
 * - tree-shake helpers
 * - avoid unnecessary runtime allocation
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

const getConfig = (opts: CompilerOptions): CodegenConfig => ({
  target: opts.target,
  tracing: opts.enableTracing ?? false,
  lifecycle: opts.enableLifecycle ?? true,
  serviceName: opts.serviceName ?? "flux",
  exposeErrorDetails: opts.exposeErrorDetails ?? false,
  specializeContext: opts.specializeContext ?? true,
  reusePort: opts.reusePort ?? false,
});

const normalizeImportPath = (p: string): string => {
  let s = p.replace(/\\/g, "/").replace(/\.(ts|tsx|js|mjs|jsx)$/, "");
  if (!s.startsWith(".")) s = "./" + s;
  return s;
};

const handlerImportName = (route: RouteDef): string => `handler_${route.handlerRef}`;
const methodHandlerName = (route: RouteDef): string => `${route.method}_${route.handlerRef}`;
const finalizeName = (route: RouteDef): string => `finalize_${route.handlerRef}`;
const constantBodyVar = (route: RouteDef): string => `BODY_${route.handlerRef}`;
const constantInitVar = (route: RouteDef): string => `INIT_${route.handlerRef}`;

const hookIdent = (name: string): string =>
  `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

const tryNormalizeConstant = (route: RouteDef): string | null => {
  if (!route.isConstantResponse || !route.constantResponse) return null;
  if (route.hooks.length > 0) return null;

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

const generateFinalizer = (route: RouteDef): string => {
  const reply = routeReplyFn(route);

  return `function ${finalizeName(route)}(result) {
  if (result instanceof Response) return result;
  return ${reply}(result);
}`;
};

const generateMethodHandler = (info: RouteInfo, cfg: CodegenConfig): string => {
  const route = info.route;
  const name = methodHandlerName(route);

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

    pre.push(`const ctx = createContext(req, params ?? EMPTY_PARAMS${ctxOptsExpr});`);

    if (route.usage.server) {
      pre.push("ctx.server = server;");
    }

    if (info.hasHooks) {
      pre.push(
        `const halted = await runHooks([${info.hookNames
          .map(hookIdent)
          .join(", ")}], ctx);`
      );
      pre.push("if (halted) return halted;");
    }

    callExpr = `${handlerImportName(route)}(ctx)`;
  } else {
    if (route.usage.query) {
      pre.push("const query = url.searchParams;");
    }

    if (info.minimalBody) {
      pre.push("const body = createLazyBody(req, BODY_LIMITS);");
    }

    if (route.usage.state) {
      pre.push("const state = new Map();");
    }

    const props: string[] = [];

    if (route.usage.params) {
      props.push("params: params ?? EMPTY_PARAMS");
    }

    if (info.minimalBody) {
      props.push("body");
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
    const needsFull = needsFullContext(route, mod, cfg, hasHooks);
    const needsBody = route.usage.body || route.usage.file;
    const minimalBody = needsBody && !needsFull;
    const minimalSendFile = route.usage.sendFile && !needsFull;

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
    };
  });

  const nonConstantInfos = routeInfos.filter((x) => x.constantJson === null);

  const anyNonConstant = nonConstantInfos.length > 0;
  const anyFullContext = nonConstantInfos.some((x) => x.needsFull);
  const anyLazyBody = nonConstantInfos.some((x) => x.minimalBody);
  const anySendFile = nonConstantInfos.some((x) => x.minimalSendFile);
  const anyHooks = cfg.lifecycle && nonConstantInfos.some((x) => x.hasHooks);

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

  if (anyHooks) {
    helpers.push(`async function runHooks(hooks, ctx) {
  for (const hook of hooks) {
    const result = await hook(ctx);

    if (result instanceof Response) return result;

    if (
      result &&
      typeof result === "object" &&
      result.ok === false &&
      result.response instanceof Response
    ) {
      return result.response;
    }
  }

  return null;
}`);
  }

  const finalizers = nonConstantInfos
    .map((info) => generateFinalizer(info.route))
    .join("\n\n");

  const handlers = routeInfos
    .map((info) => generateMethodHandler(info, cfg))
    .join("\n\n");

  const staticEntries: string[] = [];
  const dynamicEntries: DynamicRouteInfo[] = [];

  for (const info of routeInfos) {
    const handlerName = methodHandlerName(info.route);

    if (info.route.isStatic) {
      staticEntries.push(
        `[${JSON.stringify(`${info.route.method}:${info.route.path}`)}, ${handlerName}]`
      );
      continue;
    }

    const pattern = routePattern(info.route.path);

    dynamicEntries.push({
      method: info.route.method,
      regexLiteral: pattern.regexLiteral,
      paramNames: pattern.paramNames,
      handlerName,
      segmentCount: info.route.segmentCount,
      hasWildcard: info.route.path.includes("*"),
      path: info.route.path,
    });
  }

  dynamicEntries.sort((a, b) => {
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

  const dynamicRoutes = `const dynamicRoutes = [
${dynamicEntries
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

  const router = `function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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

  for (const route of dynamicRoutes) {
    if (route.method !== method && route.method !== "ALL") continue;

    const match = route.pattern.exec(path);
    if (!match) continue;

    const params = {};

    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]] = decodeParam(match[i + 1] ?? "");
    }

    return route.handler(req, params, url, server);
  }

  return notFound();
}`;

  const serverBootstrap =
    cfg.target === "bun"
      ? `if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);

  Bun.serve({
    port,
    fetch: routerFetch,
    reusePort: ${cfg.reusePort},
  });

  console.log(${JSON.stringify(cfg.serviceName)} + " listening on :" + port);
}`
      : `// Node/Deno target: export fetch handler only.`;

  return [
    handlerImports,
    hookImports,
    coreImports.join("\n"),
    missingStubs,
    constants.join("\n"),
    helpers.join("\n\n"),
    finalizers,
    handlers,
    staticRoutes,
    dynamicRoutes,
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
