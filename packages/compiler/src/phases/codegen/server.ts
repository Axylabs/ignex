/**
 * @fileoverview Codegen: server bootstrap + final assembly.
 *
 * The entry's `@ignex/core` import is assembled HERE (single source of truth):
 * structural symbols the bootstrap always references, plugin-lifecycle symbols
 * when an app config is present, and `state.usedCore` for route-conditional
 * identifiers. Generated runtime helpers are emitted unconditionally and their
 * dead code (plus unused core imports) is removed by the linker's bundler.
 */

import type { CompilerOptions } from "../../types";
import { CORE_PATH } from "./config";
import { HELPER_SOURCES } from "./helpers";
import type { CodegenState } from "./state";

/**
 * Core symbols referenced by the emitted server bootstrap itself. Everything
 * else (route-conditional identifiers) arrives via {@link CodegenState.usedCore};
 * the bundler prunes unused named imports after helper DCE.
 */
const STRUCTURAL_CORE = [
  "DEFAULT_MAX_REQUEST_BODY_SIZE",
  "DEFAULT_SERVER_IDLE_TIMEOUT",
  "DEFAULT_WS_MAX_PAYLOAD_LENGTH",
  "EMPTY_LIFECYCLE",
  "installProcessGuards",
  "resolveServeTls",
] as const;

/** Symbols needed only when the app config contributes plugins/lifecycle. */
const APP_CONFIG_CORE = [
  "createPluginContext",
  "mergeLifeCycle",
  "pluginsToLifeCycle",
  "pluginContextToLifecycle",
  "setServeBootInfo",
] as const;

/**
 * Core symbols referenced by the generated runtime helper sources. All helpers
 * are emitted unconditionally (the bundler prunes dead ones), so every symbol
 * any helper may call must be imported for the pre-link module to resolve;
 * unused bindings vanish together with their dead callers.
 */
const HELPER_CORE = [
  "ValidationError",
  "applySet",
  "createContext",
  "debugStageEnd",
  "errorToResponse",
  "runHooks",
  "runTimed",
  "validateAsync",
] as const;

/** Assemble the pruned-at-link `@ignex/core` named import for the entry. */
const buildCoreImport = (state: CodegenState): string => {
  const names = new Set<string>(STRUCTURAL_CORE);
  if (state.hasAppConfig) for (const n of APP_CONFIG_CORE) names.add(n);
  for (const n of HELPER_CORE) names.add(n);
  for (const n of state.usedCore) names.add(n);
  return `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(CORE_PATH)};`;
};

/**
 * Emit the `Bun.serve` bootstrap, assemble the `@ignex/core` import, and
 * collect the final module string (imports → header → helpers → cache decls →
 * functions).
 */
export const stageServer = (state: CodegenState, opts: CompilerOptions): string => {
  const { cfg, imports, header, cacheDecls, functions } = state;

  // Emit server bootstrap. `maxRequestBodySize` defaults to the core constant
  // (64MB — a deliberate ceiling) instead of Bun's larger implicit default;
  // an explicit compiler option still wins.
  functions.push(`const __serveOptions = {
  port: Number(process.env.PORT ?? __serverCfg.port ?? 3000),
  hostname: __serverCfg.hostname,
  reusePort: ${cfg.reusePort ? "true" : "(__serverCfg.reusePort ?? false)"},
  maxRequestBodySize: __serverCfg.maxRequestBodySize ?? ${
    opts.maxRequestBodySize ?? "DEFAULT_MAX_REQUEST_BODY_SIZE"
  },
  routes: __routes,
  fetch: __fallback,
};`);

  // HTTPS by default: `resolveServeTls` ran in the header (BEFORE plugin boot,
  // so plugin init logs print scheme-correct URLs) and guarantees a `tls`
  // block unless `server.https: false`. In production with no certs it warns
  // and falls back to HTTP/1; the production decision is BAKED from the build
  // shape so a prod artifact never auto-generates certs at launch. The
  // resolved `__serveTls` const feeds the serve options here.
  //
  // HTTP/2: `server.h2` / `server.http2` (alias) maps to Bun.serve's `http2`
  // option (Bun ≥1.4.1 negotiates h2 over TLS via ALPN). Only set over TLS.
  functions.push(`if (__serveTls.tls) __serveOptions.tls = __serveTls.tls;
if ((__serverCfg.http2 ?? __serverCfg.h2) && __serveTls.tls) __serveOptions.http2 = true;`);

  // WS handler wiring: inject the core default frame ceiling when the app
  // config didn't set `maxPayloadLength` (spread AFTER so an explicit value
  // always wins). Copied — `__serverCfg` is never mutated.
  functions.push(
    `if (__serverCfg.websocket) __serveOptions.websocket = { maxPayloadLength: DEFAULT_WS_MAX_PAYLOAD_LENGTH, ...__serverCfg.websocket };`,
  );
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
  // stop accepting new connections and DRAIN active requests (`stop(false)` —
  // `stop(true)` would FORCE-close in-flight requests) — for EVERY app, with
  // or without an app config. The old config-less path exited immediately,
  // killing in-flight requests on every rolling deploy/Ctrl-C.
  // With plugins: close plugin resources (DB connections, stores), then exit
  // as soon as closing finishes. Without: rely on Bun's natural process exit
  // once the drained event loop empties (no lingering handles), with a 10s
  // hard deadline (unref'd, so it only fires when something is wedged — a
  // stuck keep-alive/WS connection must never hang a container stop forever).
  {
    const drainBody = state.hasAppConfig
      ? `  Promise.resolve()
    .then(() => __pluginContext.closeAll())
    .catch((__err) => console.error("[ignex] plugin close error:", __err))
    .finally(() => process.exit(0));`
      : `  // No plugin resources to close — let the drained event loop exit naturally.`;
    functions.push(`let __shuttingDown = false;
const __shutdown = (__signal) => {
  if (__shuttingDown) return;
  __shuttingDown = true;
  console.log("[ignex] received " + __signal + " — draining connections");
  try { __server.stop(false); } catch (__err) { console.error("[ignex] stop error:", __err); }
${drainBody}
  setTimeout(() => process.exit(0), 10000).unref?.();
};
process.on("SIGTERM", () => __shutdown("SIGTERM"));
process.on("SIGINT", () => __shutdown("SIGINT"));`);
  }

  functions.push(`export default __server;`);

  // Emit ALL runtime helpers unconditionally — the linker's bundler performs
  // dead-code elimination over the entry, so helpers no route references are
  // removed from the final artifact (no string-key usage tracking).
  const helperBlock = Object.values(HELPER_SOURCES).join("\n\n");

  return [
    `import { existsSync, readFileSync } from "node:fs";`,
    buildCoreImport(state),
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
