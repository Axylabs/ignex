/**
 * @fileoverview Codegen: stage 2 — header constants + inlined handlers.
 */

import type { CompilerOptions } from "../../types";
import { indentBody } from "./helpers";
import type { CodegenState } from "./state";

/**
 * Dev error-overlay page served while a build-error marker exists (written by
 * `ignex dev` on a failed compile). Shows the compiler diagnostic in the
 * browser; the terminal already prints it.
 */
export const DEV_OVERLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ignex · build error</title>
<style>
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0f1419; color: #e6edf3; }
  .wrap { max-width: 860px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 18px; color: #ff6b6b; }
  .box { background: #161c23; border: 1px solid #26313c; border-left: 4px solid #ff6b6b; border-radius: 8px; padding: 16px 20px; margin-top: 16px; white-space: pre-wrap; word-break: break-word; }
  .hint { color: #8b949e; font-size: 13px; margin-top: 20px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>⚡ ignex — compilation failed</h1>
  <div class="box">__MESSAGE__</div>
  <div class="hint">The previous build is still serving. Fix the error and save a file — ignex dev rebuilds automatically.</div>
</div>
</body>
</html>`;

/** Emit the always-present header constants (limits, flags, lifecycle stage chains). */
export const stageHeader = (state: CodegenState, opts: CompilerOptions): void => {
  const { cfg, header } = state;

  header.push(`const EMPTY_PARAMS = Object.freeze({});`);

  header.push(`const __EMPTY_SET = Object.freeze({ headers: Object.freeze({}) });`);

  header.push(`const BODY_LIMITS = Object.freeze({
  maxJsonBytes: ${opts.maxJsonBytes ?? 2 * 1024 * 1024},
  maxTextBytes: ${opts.maxTextBytes ?? 2 * 1024 * 1024},
  maxFormBytes: ${opts.maxFormBytes ?? 2 * 1024 * 1024},
  maxFileBytes: ${opts.maxFileBytes ?? 20 * 1024 * 1024},
});`);

  // Shared context options for non-route contexts (OPTIONS/404/405/error
  // paths). Hoisted so the `{ body: BODY_LIMITS }` literal is not re-allocated
  // per request. Declared AFTER `BODY_LIMITS` (const TDZ — this used to
  // reference it before initialization and every built server failed to load).
  header.push(`const __ctxOpts = Object.freeze({ body: BODY_LIMITS });`);

  // Shared TextEncoder — reused by jsonReply/textReply/htmlReply. The previous
  // `new TextEncoder()` per response allocated a fresh encoder per reply.
  header.push(`const __encoder = new TextEncoder();`);

  header.push(`const EXPOSE_ERRORS = ${cfg.exposeErrorDetails ? "true" : "false"};`);
  header.push(`const __TRACE = ${cfg.enableTraceHeaders ? "true" : "false"};`);
  header.push(`const __ACCESS_LOG = ${cfg.enableAccessLog ? "true" : "false"};`);
  // Lifecycle-stage instrumentation (debugbar waterfall rows): a module
  // constant, so when no `debugbar()` is kept for this build the `__TRACE_DEBUG
  // ? runTimed(...) : runHooks(...)` guards const-fold to the bare calls —
  // zero closures per request on the production needsFull path.
  header.push(`const __TRACE_DEBUG = ${state.traceDebug};`);
  // Dev error overlay: enabled outside production (the marker is written by
  // `ignex dev` on a failed compile). The fs probe inside __fallback is
  // skipped entirely in production artifacts (const-folded to false).
  header.push(`const __DEV_ERROR_MARKER = process.env.NODE_ENV !== "production";`);
  header.push(`const __DEV_OVERLAY_HTML = ${JSON.stringify(DEV_OVERLAY_HTML)};`);

  if (state.hasAppConfig) {
    // Dev-only plugins (the `debugbar()` dashboard) mark themselves with
    // `__ignexDevOnly` when they are disabled at runtime (e.g. a dev-built
    // artifact running with NODE_ENV=production). Filter them out of the
    // lifecycle so a disabled dev tool costs zero per-request hooks — the
    // plugin list is small and this runs once at boot.
    header.push(
      `const __appPlugins = (__appConfig.plugins ?? []).filter((__p) => !(__p != null && typeof __p === "object" && __p.__ignexDevOnly === true));`,
    );
    header.push(`const __pluginContext = createPluginContext();`);
    // A throwing plugin must fail boot with a clear, attributable error (not a
    // cryptic module-load failure / unhandled rejection).
    header.push(`for (const __p of __appPlugins) {
  try {
    if (typeof __p === "function") await __p(__pluginContext);
    else if (__p && typeof __p.setup === "function") await __p.setup(__pluginContext);
    else if (__p && typeof __p.init === "function") await __p.init();
  } catch (__err) {
    const __name = (__p && (typeof __p === "object" ? (__p.name ?? __p.constructor?.name) : undefined)) ?? "anonymous plugin";
    throw new Error("[ignex] plugin boot failed for " + __name + ": " + (__err instanceof Error ? __err.message : String(__err)), { cause: __err });
  }
}`);
    header.push(
      `const __pluginLC = mergeLifeCycle(pluginContextToLifecycle(__pluginContext), pluginsToLifeCycle(__appPlugins));`,
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

  // Static default response headers (security headers, wildcard CORS) from the
  // app `server.headers` config. Merged into every framework-built response by
  // `__withBody` — replaces per-request `security()`/`cors()` hooks with a
  // frozen-object spread at Response construction. `null` when unset (a module
  // constant, so the branch folds away and unconfigured servers pay nothing).
  header.push(
    `const __DEFAULT_HEADERS = __serverCfg.headers ? Object.freeze({ ...__serverCfg.headers }) : null;`,
  );

  // Prebuilt lifecycle stage chains — composed once, not per request. Stage
  // emptiness is hoisted to boot-time module constants so the JIT folds the
  // per-request guards: empty stages become dead code, non-empty stages are a
  // const-true branch. Computed once at instantiation — the lifecycle arrays
  // are immutable after boot.
  header.push(`const __preParseStages = [...__lc.start, ...__lc.request, ...__lc.parse, ...__lc.transform];
const __preStages = [...__lc.start, ...__lc.request, ...__lc.parse, ...__lc.transform, ...__lc.beforeHandle];
const __postStages = [...__lc.afterHandle, ...__lc.mapResponse];
const __hasPreParse = __preParseStages.length > 0;
const __hasPreStages = __preStages.length > 0;
const __hasPostStages = __postStages.length > 0;
const __hasBeforeHandle = (__lc.beforeHandle ?? []).length > 0;
const __hasAfterHandle = (__lc.afterHandle ?? []).length > 0;
const __hasMapResponse = (__lc.mapResponse ?? []).length > 0;
const __hasAfterResponse = (__lc.afterResponse ?? []).length > 0;
const __hasTrace = (__lc.trace ?? []).length > 0;`);
};

/** Emit inlined handler functions (self-contained modules) before route handlers. */
export const stageInlinedHandlers = (state: CodegenState): void => {
  const { functions } = state;

  for (const [ref, inline] of state.inlineHandlers) {
    functions.push(`// Inlined route handler (self-contained module)
const handler_${ref} = ${inline.isAsync ? "async " : ""}(${inline.param}) => {
${indentBody(inline.body)}
};`);
  }
};
