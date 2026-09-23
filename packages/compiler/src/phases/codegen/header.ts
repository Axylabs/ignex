/**
 * @fileoverview Codegen: stage 2 — header constants + inlined handlers.
 */

import type { CompilerOptions } from "../../types";
import { emitHeatModule } from "./heat";
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

  // Whether forwarded headers are authoritative for this deployment. Folded
  // here, ONCE at boot, from the plugin objects the artifact is about to boot
  // — the same `IgnexPlugin.contextOptions` declaration the interpreted
  // `createApp` merges, so the two paths cannot disagree about `ctx.ip`.
  //
  // Before this, nothing in the compiler mentioned `trustProxy` at all, so the
  // compiled context never carried it: `ctx.ip` skipped the forwarded-header
  // branch and every client resolved to the socket address (the proxy's, behind
  // a proxy). `__ignexDevOnly` plugins are skipped exactly like the
  // `__appPlugins` filter below, so a disabled dev tool cannot decide this.
  header.push(
    state.hasAppConfig
      ? `const __TRUST_PROXY = (() => {
  for (const __p of __appConfig.plugins ?? []) {
    if (__p == null || typeof __p !== "object" || __p.__ignexDevOnly === true) continue;
    const __co = __p.contextOptions;
    if (__co != null && __co.trustProxy === true) return true;
  }
  return false;
})();`
      : `const __TRUST_PROXY = false;`,
  );

  // Shared context options for non-route contexts (OPTIONS/404/405/error
  // paths). Hoisted so the `{ body: BODY_LIMITS }` literal is not re-allocated
  // per request. Declared AFTER `BODY_LIMITS` and `__TRUST_PROXY` (const TDZ —
  // this used to reference `BODY_LIMITS` before initialization and every built
  // server failed to load).
  header.push(`const __ctxOpts = Object.freeze({ body: BODY_LIMITS, trustProxy: __TRUST_PROXY });`);

  // Shared TextEncoder — reused by jsonReply/textReply/htmlReply. The previous
  // `new TextEncoder()` per response allocated a fresh encoder per reply.
  header.push(`const __encoder = new TextEncoder();`);

  // Pre-aborted-request short-circuit, shared with the interpreted lifecycle
  // (`abortedResponse()` in @ignex/core). Hoisted so an already-gone client
  // pays ZERO per-request allocation: the route core fns return this same
  // bodyless 200 before creating a context, running hooks, or calling the
  // handler. Mirrors `runLifecycle`'s pre-check so AOT and interpreted agree.
  // `@__PURE__` lets the linker drop the constant + its import entirely on
  // constant-only builds (no core fn references it).
  header.push(`const __abortedResponse = /* @__PURE__ */ abortedResponse();`);
  state.usedCore.add("abortedResponse");

  header.push(`const EXPOSE_ERRORS = ${cfg.exposeErrorDetails ? "true" : "false"};`);
  header.push(`const __TRACE = ${cfg.enableTraceHeaders ? "true" : "false"};`);
  header.push(`const __ACCESS_LOG = ${cfg.enableAccessLog ? "true" : "false"};`);
  // Lifecycle-stage instrumentation (debugbar waterfall rows): a module
  // constant, so when no `debugbar()` is kept for this build the `__TRACE_DEBUG
  // ? runTimed(...) : runHooks(...)` guards const-fold to the bare calls —
  // zero closures per request on the production needsFull path.
  header.push(`const __TRACE_DEBUG = ${state.traceDebug};`);
  // Bake the build shape: a production-built artifact stays toolbar-free even
  // when launched without `NODE_ENV=production` in the environment — dev-only
  // plugins (debugbar) read this flag and inert-construct themselves.
  if (state.isProductionBuild) {
    header.push(`globalThis.__IGNEX_PROD_BUILD = true;`);
  }
  // Dev error overlay: enabled outside production (the marker is written by
  // `ignex dev` on a failed compile). The fs probe inside __fallback is
  // skipped entirely in production artifacts (const-folded to false). The
  // flag is baked from the BUILD shape so a prod-built artifact launched
  // without `NODE_ENV=production` never pays the per-fallback fs probe.
  header.push(
    `const __DEV_ERROR_MARKER = ${
      state.isProductionBuild ? "false" : 'process.env.NODE_ENV !== "production"'
    };`,
  );
  header.push(`const __DEV_OVERLAY_HTML = ${JSON.stringify(DEV_OVERLAY_HTML)};`);

  // Dev-only profile-guided heat capture (`ignex dev`): per-route request
  // counters flushed to <outDir>/hot-routes.json. Never emitted in
  // production builds (the option defaults off and is fingerprinted).
  if (cfg.heatCapture) {
    header.push(emitHeatModule());
  }

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
    // Resolve the server config + TLS BEFORE plugin boot so every plugin's
    // `init` hook logs scheme-correct endpoint URLs (see http/serve-boot.ts).
    header.push(`const __serverCfg = __appConfig.server ?? {};`);
    header.push(`const __serveTls = resolveServeTls(__serverCfg, {
  production: ${state.isProductionBuild ? "true" : 'process.env.NODE_ENV === "production"'},
  certDir: (import.meta.dir || process.cwd()) + "/certs",
});`);
    header.push(
      `setServeBootInfo({ protocol: __serveTls.protocol, port: Number(process.env.PORT ?? __serverCfg.port ?? 3000), hostname: __serverCfg.hostname });`,
    );
    // A throwing plugin must fail boot with a clear, attributable error (not a
    // cryptic module-load failure / unhandled rejection). `reportPluginBootFailure`
    // prints a configuration-first report (`.env` state, the connection vars the
    // driver rejected, what to fix) and returns a COMPACT error — the raw driver
    // error is deliberately not attached as `cause`, because Bun's uncaught-error
    // printer expands a `MongoServerError`'s enumerable BSON graph into hundreds
    // of lines that say nothing about the fix.
    header.push(`for (const __p of __appPlugins) {
  try {
    if (typeof __p === "function") await __p(__pluginContext);
    else if (__p && typeof __p.setup === "function") await __p.setup(__pluginContext);
    else if (__p && typeof __p.init === "function") await __p.init();
  } catch (__err) {
    const __name = (__p && (typeof __p === "object" ? (__p.name ?? __p.constructor?.name) : undefined)) ?? "anonymous plugin";
    throw reportPluginBootFailure(__name, __err);
  }
}`);
    if (state.realtimeConsumerRefs.length > 0) {
      // Auto-registered realtime consumers (src/realtime/consumers): each
      // module default-exports register(). Called AFTER plugin init so the
      // novaPlugin events hub is already bound — no manual post-realtimePlugin
      // plugin required. A user can still register their own handlers.
      header.push(
        `const __novaPlugin = __appPlugins.find((__p) => __p != null && typeof __p === "object" && __p.name === "nova");`,
      );
      header.push(`if (__novaPlugin) {`);
      header.push(`  for (const __consumer of [${state.realtimeConsumerRefs.join(", ")}]) {`);
      header.push(
        `    const __register = typeof __consumer === "function" ? __consumer : __consumer != null && typeof __consumer === "object" && typeof __consumer.default === "function" ? __consumer.default : __consumer != null && typeof __consumer === "object" && typeof __consumer.register === "function" ? __consumer.register : undefined;`,
      );
      header.push(`    if (typeof __register === "function") await __register();`);
      header.push(`  }`);
      header.push(`}`);
    }
    header.push(
      `const __pluginLC = mergeLifeCycle(pluginContextToLifecycle(__pluginContext), pluginsToLifeCycle(__appPlugins));`,
    );
    header.push(`const __userLC = __appConfig.lifecycle ?? __appConfig.hooks ?? {};`);
    header.push(
      `const __lc = mergeLifeCycle(mergeLifeCycle(EMPTY_LIFECYCLE, __pluginLC), __userLC);`,
    );
    // Plugin-declared, app-invariant response headers (currently the
    // `security()` header set). Hoisted into `__DEFAULT_HEADERS` below so they
    // are present when `__withBody` CONSTRUCTS a response, letting the plugin
    // skip its per-response chain of native `Headers.set` calls. Read straight
    // off the plugin objects (a plain property — no `init` needed) and merged
    // once here rather than per request.
    header.push(`const __pluginDefaults = (() => {
  let __merged;
  for (const __p of __appPlugins) {
    if (__p == null || typeof __p !== "object" || !__p.responseDefaults) continue;
    __merged = { ...(__merged ?? {}), ...__p.responseDefaults };
  }
  return __merged;
})();`);
  } else {
    header.push(`const __lc = EMPTY_LIFECYCLE;`);
    header.push(`const __serverCfg = {};`);
    header.push(`const __pluginDefaults = undefined;`);
    // Config-less servers still resolve TLS (HTTPS-by-default policy); the
    // result feeds the bootstrap below. No boot info broadcast — no plugins.
    header.push(`const __serveTls = resolveServeTls(__serverCfg, {
  production: ${state.isProductionBuild ? "true" : 'process.env.NODE_ENV === "production"'},
  certDir: (import.meta.dir || process.cwd()) + "/certs",
});`);
  }

  // Static default response headers applied to every framework-built response
  // by `__withBody` — the plugin-declared set (security headers) plus the app
  // `server.headers` config, with the explicit config winning on conflict.
  // Folding the PLUGIN's declarative `responseDefaults` in here is what lets a
  // decorating plugin skip its per-response chain of native `Headers.set`
  // calls: the values are already in the header record when the `Response` is
  // constructed (see the `markDecoratedResponse` call in `__withBody`). `null`
  // when neither source is present (a module constant, so the branch folds
  // away and unconfigured servers pay nothing).
  //
  // The merged values are sanitized ONCE here because `__withBody` bakes them
  // into the memoized base `Headers` without re-checking each value
  // (~18 ns/header when paid per response). Doing it
  // at boot keeps the response-splitting guarantee for free at request time.
  // Mirrors `sanitizeHeaderValue` in `@ignex/core`'s `http/finalize.ts`.
  header.push(`const __CTL_TEST = /[\\r\\n\\0]/;
const __CTL_STRIP = /[\\r\\n\\0]/g;
const __sanitizeHeaderValue = (value) => __CTL_TEST.test(value) ? value.replace(__CTL_STRIP, "") : value;`);
  header.push(
    `const __DEFAULT_HEADERS = (() => {
  if (!__pluginDefaults && !__serverCfg.headers) return null;
  const __merged = { ...__pluginDefaults, ...__serverCfg.headers };
  for (const __k in __merged) __merged[__k] = __sanitizeHeaderValue(String(__merged[__k]));
  return Object.freeze(__merged);
})();`,
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

  // Fused lifecycle dispatchers (WS1): when the app's plugin layer is fully
  // statically attributed AND carries no user lifecycle, the artifact
  // composes DIRECT plugin-hook chains at boot and runs them with the narrow
  // fused runners (core/lifecycle/fused.ts) instead of walking the
  // HookContainer stage arrays — no per-hook synthesized result object, no
  // container dispatch. `__fusedOK` is a boot-time STRUCTURAL gate: the fused
  // chain must exactly mirror the runtime stage counts (plugins produce only
  // `request` + a composed `afterHandle` container; user lifecycle hooks
  // would add containers and trip one of the count checks). Any mismatch
  // falls back to `runHooks`, so the emitted lanes behave identically either
  // way. The dispatchers are emitted in EVERY build (config-less servers get
  // the runHooks-only fallback) so the route lanes have one emission shape.
  if (state.hasAppConfig) {
    header.push(`const __fused = buildFusedChains(__appPlugins);
const __fusedOK =
  __fused.preParse.length === __preParseStages.length &&
  __lc.mapResponse.length === 0 &&
  __lc.afterHandle.length === (__fused.post.length > 0 ? 1 : 0);
const __runPreParse = __fusedOK
  ? (ctx) => runFusedPre(__fused.preParse, ctx)
  : (ctx) => runHooks(__preParseStages, ctx);
const __runAfter = __fusedOK
  ? (ctx, response) => runFusedPost(__fused.post, ctx, response)
  : (ctx, response) => runHooks(__lc.afterHandle, ctx, response);`);
    state.usedCore.add("buildFusedChains");
    state.usedCore.add("runFusedPre");
    state.usedCore.add("runFusedPost");
  } else {
    header.push(`const __fusedOK = false;
const __runPreParse = (ctx) => runHooks(__preParseStages, ctx);
const __runAfter = (ctx, response) => runHooks(__lc.afterHandle, ctx, response);`);
  }

  // Measurement-only ablation of the generated route wrapper. Enabled at BUILD
  // time with IGNEX_ABLATE_BUILD=1 and selected per server process with
  // IGNEX_ABLATE=<finalize|hooks|applyset>, so ONE build can be driven as many
  // variants in a single interleaved measurement run. When the build flag is
  // unset (every production build) these are literal `false`, so the guards in
  // the route wrapper fold away and the emitted server is unchanged.
  header.push(
    process.env.IGNEX_ABLATE_BUILD === "1"
      ? `const __ABLATE = new Set((process.env.IGNEX_ABLATE || "").split(","));
const __ABL_FINALIZE = __ABLATE.has("finalize");
const __ABL_HOOKS = __ABLATE.has("hooks");
const __ABL_APPLYSET = __ABLATE.has("applyset");`
      : `const __ABL_FINALIZE = false;
const __ABL_HOOKS = false;
const __ABL_APPLYSET = false;`,
  );
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
