/**
 * @fileoverview Codegen: server bootstrap + helper pruning + final assembly.
 */

import type { CompilerOptions } from "../../types";
import { CORE_PATH } from "./config";
import { HELPER_SOURCES, HELPERS, resolveUsedHelpers } from "./helpers";
import type { CodegenState } from "./state";

/**
 * Emit the `Bun.serve` bootstrap, prune generated helpers to those actually
 * referenced, compute the minimal `@ignex/core` import, and assemble the final
 * module string (imports → header → helpers → cache decls → functions).
 */
export const stageServer = (state: CodegenState, opts: CompilerOptions): string => {
  const { cfg, imports, header, cacheDecls, functions, helpers } = state;

  // Emit server bootstrap.
  functions.push(`const __serveOptions = {
  port: Number(process.env.PORT ?? __serverCfg.port ?? 3000),
  hostname: __serverCfg.hostname,
  reusePort: ${cfg.reusePort ? "true" : "(__serverCfg.reusePort ?? false)"},
  maxRequestBodySize: __serverCfg.maxRequestBodySize ?? ${opts.maxRequestBodySize ?? 128 * 1024 * 1024},
  routes: __routes,
  fetch: __fallback,
};`);

  // HTTPS by default: `Bun.serve` needs a `tls` block for TLS, so
  // `resolveServeTls` guarantees one (user certs, or auto-generated dev certs)
  // unless `server.https: false`. In production with no certs it warns and
  // falls back to HTTP/1. Dev certs are cached under `<outDir>/certs`
  // (relative to the emitted file, so the output stays machine-independent).
  functions.push(`const __serveTls = resolveServeTls(__serverCfg, {
  production: process.env.NODE_ENV === "production",
  certDir: (import.meta.dir || process.cwd()) + "/certs",
});
if (__serveTls.tls) __serveOptions.tls = __serveTls.tls;
if (__serverCfg.h2 && __serveTls.tls) __serveOptions.h2 = true;`);

  functions.push(`if (__serverCfg.websocket) __serveOptions.websocket = __serverCfg.websocket;`);
  if (state.wsHandlers.length === 1) {
    // A single WS route: its `wsHandler` is the server websocket handler
    // directly (the common case — no dispatch overhead).
    const only = state.wsHandlers[0];
    if (only) {
      functions.push(`__serveOptions.websocket ??= ${only.handler};`);
    }
  } else if (state.wsHandlers.length > 1) {
    // Multiple WS routes: `Bun.serve` has exactly ONE `websocket` handler, so
    // route each socket to ITS route's `wsHandler` via the path recorded in
    // the upgrade `data` (see codegen/routes/ws.ts). Unknown/untagged sockets
    // fall back to the first handler so bookkeeping never leaks.
    const first = state.wsHandlers[0];
    if (first) {
      const map = state.wsHandlers
        .map(({ path, handler }) => `${JSON.stringify(path)}: ${handler}`)
        .join(", ");
      functions.push(`const __wsHandlers = { ${map} };
__serveOptions.websocket ??= {
  open(ws) { (__wsHandlers[ws.data?.__route] ?? ${first.handler}).open?.(ws); },
  message(ws, msg) { (__wsHandlers[ws.data?.__route] ?? ${first.handler}).message?.(ws, msg); },
  drain(ws) { (__wsHandlers[ws.data?.__route] ?? ${first.handler}).drain?.(ws); },
  close(ws, code, reason) { (__wsHandlers[ws.data?.__route] ?? ${first.handler}).close?.(ws, code, reason); },
};`);
    }
  }
  functions.push(
    `__serveOptions.idleTimeout = __serverCfg.idleTimeout ?? DEFAULT_SERVER_IDLE_TIMEOUT;`,
  );

  // Static default response headers (security headers, wildcard CORS): served
  // natively by Bun's default-header sink — applied to every response with
  // zero per-request JS (replaces the per-request `security()`/`cors()` hooks).
  functions.push(`if (__serverCfg.headers) __serveOptions.headers = __serverCfg.headers;`);

  // Process-level crash backstop: log unhandled rejections instead of letting
  // Bun terminate the server; exit(1) on an uncaught exception so a supervisor
  // restarts a fresh process. Installed before Bun.serve accepts traffic.
  functions.push(`installProcessGuards();`);

  functions.push(`const __server = Bun.serve(__serveOptions);`);

  functions.push(
    `console.log(${JSON.stringify(cfg.serviceName)} + " listening on " + __serveTls.protocol + "://" + (__server.hostname || "localhost") + ":" + __server.port);`,
  );

  // Graceful shutdown on SIGTERM/SIGINT (containers, rolling deploys, Ctrl-C):
  // stop accepting new connections, drain active requests, close plugin
  // resources (DB connections, stores), then exit. A 10s hard deadline
  // prevents a stuck plugin close from hanging a container stop forever.
  if (state.hasAppConfig) {
    functions.push(`let __shuttingDown = false;
const __shutdown = (__signal) => {
  if (__shuttingDown) return;
  __shuttingDown = true;
  console.log("[ignex] received " + __signal + " — draining connections");
  try { __server.stop(true); } catch (__err) { console.error("[ignex] stop error:", __err); }
  Promise.resolve()
    .then(() => __pluginContext.closeAll())
    .catch((__err) => console.error("[ignex] plugin close error:", __err))
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref?.();
};
process.on("SIGTERM", () => __shutdown("SIGTERM"));
process.on("SIGINT", () => __shutdown("SIGINT"));`);
  } else {
    functions.push(`process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));`);
  }

  functions.push(`export default __server;`);

  // Emit runtime helpers (pruned to what is actually referenced).
  const usedHelpers = resolveUsedHelpers(helpers);

  // Prune the `@ignex/core` import to only the symbols the emitted code
  // actually references: header-required symbols, per-route core deps
  // (markCore), and the transitive core deps of used generated helpers.
  const neededCore = new Set<string>([
    "DEFAULT_SERVER_IDLE_TIMEOUT",
    "EMPTY_LIFECYCLE",
    "installProcessGuards",
    "resolveServeTls",
  ]);
  if (state.hasAppConfig) {
    neededCore.add("createPluginContext");
    neededCore.add("mergeLifeCycle");
    neededCore.add("pluginsToLifeCycle");
    neededCore.add("pluginContextToLifecycle");
  }
  for (const name of state.uniqueCore) {
    if (helpers.isCoreUsed(name)) neededCore.add(name);
  }
  for (const name of usedHelpers) {
    for (const dep of HELPERS[name]?.core ?? []) neededCore.add(dep);
  }
  const coreImport = `import { ${[...neededCore].sort().join(", ")} } from ${JSON.stringify(
    CORE_PATH,
  )};`;

  const helperBlock = Object.keys(HELPERS)
    .filter((name) => (cfg.treeshakeRuntime ? usedHelpers.has(name) : true))
    .map((name) => HELPER_SOURCES[name])
    .join("\n\n");

  return [
    `import { existsSync, readFileSync } from "node:fs";`,
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
