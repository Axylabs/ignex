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

  functions.push(`if (__serverCfg.websocket) __serveOptions.websocket = __serverCfg.websocket;`);
  if (state.wsHandlers.length > 0) {
    // WS routes provide the server websocket handler; an app-config
    // `websocket` (escape hatch) takes precedence.
    functions.push(`__serveOptions.websocket ??= ${state.wsHandlers[0]};`);
  }
  functions.push(
    `if (__serverCfg.idleTimeout) __serveOptions.idleTimeout = __serverCfg.idleTimeout;`,
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
    `console.log(${JSON.stringify(cfg.serviceName)} + " listening on http://" + (__server.hostname || "localhost") + ":" + __server.port);`,
  );

  functions.push(`export default __server;`);

  // Emit runtime helpers (pruned to what is actually referenced).
  const usedHelpers = resolveUsedHelpers(helpers);

  // Prune the `@ignex/core` import to only the symbols the emitted code
  // actually references: header-required symbols, per-route core deps
  // (markCore), and the transitive core deps of used generated helpers.
  const neededCore = new Set<string>(["EMPTY_LIFECYCLE", "installProcessGuards"]);
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
