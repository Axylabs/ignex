/**
 * @fileoverview Public sub-barrel: lifecycle (hooks, lifecycle, plugin) +
 * the standalone `generateOpenAPI` re-exported from the `@ignex/core` entry
 * (split from the barrel `src/index.ts` by section banner — move-only; `export`
 * statements verbatim).
 */

// The fused lifecycle helpers precede the lifecycle banner in the source
// barrel — kept first here to preserve order.
export { buildFusedChains, runFusedPost, runFusedPre } from "../lifecycle/fused";
// ── lifecycle ───────────────────────────────────────────────────
export type { HookFn, HookResult } from "../lifecycle/hooks";
export {
  composeHooks,
  continueHook,
  executeHooks,
  haltHook,
  mergeHookArrays,
  mergeLifeCycle,
} from "../lifecycle/hooks";
export type { AppOptions, IgnexApp, ServeOptions } from "../lifecycle/lifecycle";
export {
  buildPostStages,
  buildPreStages,
  createApp,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  DEFAULT_WS_MAX_PAYLOAD_LENGTH,
  debugStageEnd,
  lifecycleTracing,
  POST_HANDLER_STAGES,
  PRE_HANDLER_STAGES,
  PRE_PARSE_STAGES,
  runHooks,
  runLifecycle,
  runTimed,
} from "../lifecycle/lifecycle";
export type { IgnexPlugin, PluginContext, RoutePattern } from "../lifecycle/plugin";
export {
  composePlugins,
  createPatternMatcher,
  createPluginContext,
  hookToPlugin,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "../lifecycle/plugin";
export { generateOpenAPI } from "../openapi";
