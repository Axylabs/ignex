/**
 * @fileoverview Plugin Architecture — barrel.
 *
 * Preserves the pre-split `plugin.ts` import surface: the plugin types, the
 * registry, composition + pattern helpers, and the plugin → lifecycle bridge.
 */

export { composePlugins, createPatternMatcher } from "./composition";
export {
  collectContextOptions,
  collectResponseDefaults,
  hookToPlugin,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "./lifecycle-bridge";
export { createPluginContext } from "./registry";
export type { IgnexPlugin, PluginContext, RoutePattern } from "./types";
