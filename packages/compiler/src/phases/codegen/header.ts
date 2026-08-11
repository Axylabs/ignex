/**
 * @fileoverview Codegen: stage 2 — header constants + inlined handlers.
 */

import type { CompilerOptions } from "../../types";
import { indentBody } from "./helpers";
import type { CodegenState } from "./state";

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

  header.push(`const EXPOSE_ERRORS = ${cfg.exposeErrorDetails ? "true" : "false"};`);
  header.push(`const __TRACE = ${cfg.enableTraceHeaders ? "true" : "false"};`);
  header.push(`const __ACCESS_LOG = ${cfg.enableAccessLog ? "true" : "false"};`);

  if (state.hasAppConfig) {
    header.push(`const __pluginContext = createPluginContext();`);
    header.push(`for (const __p of __appConfig.plugins ?? []) {
  if (typeof __p === "function") await __p(__pluginContext);
  else if (__p && typeof __p.setup === "function") await __p.setup(__pluginContext);
  else if (__p && typeof __p.init === "function") await __p.init();
}`);
    header.push(
      `const __pluginLC = mergeLifeCycle(pluginContextToLifecycle(__pluginContext), pluginsToLifeCycle(__appConfig.plugins ?? []));`,
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

  // Prebuilt lifecycle stage chains — composed once, not per request.
  header.push(`const __preParseStages = [...__lc.start, ...__lc.request, ...__lc.parse, ...__lc.transform];
const __preStages = [...__lc.start, ...__lc.request, ...__lc.parse, ...__lc.transform, ...__lc.beforeHandle];
const __postStages = [...__lc.afterHandle, ...__lc.mapResponse];
const __hasPreStages = __preStages.length > 0;
const __hasPostStages = __postStages.length > 0;
const __hasAfterResponse = (__lc.afterResponse ?? []).length > 0;`);
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
