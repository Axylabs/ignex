/**
 * @fileoverview Codegen: response-cache wrapper emission.
 */

import type { RouteIR } from "../../../types";
import { cacheVar, methodHandlerName } from "../identifiers";
import type { CodegenState } from "../state";

/** `getCacheConfig` return shape (route `cache` config → cache options). */
export interface RouteCacheConfig {
  readonly ttlMs?: number;
  readonly staleTtlMs?: number;
  readonly vary?: string[];
}

/**
 * Emit the cache variable and the outer handler that serves/refreshes it.
 * The core handler (passed by name) does the actual work.
 */
export const emitCacheWrapper = (
  state: CodegenState,
  route: RouteIR,
  cacheConfig: RouteCacheConfig,
  coreName: string,
): void => {
  state.helpers.markCore("HttpResponseCache");
  state.cacheDecls.push(
    `const ${cacheVar(route)} = new HttpResponseCache(${JSON.stringify({
      max: 1000,
      ...cacheConfig,
    })});`,
  );

  state.functions.push(`function ${methodHandlerName(route)}(req, params, server) {
  return ${cacheVar(route)}.getOrSet(req, () => ${coreName}(req, params, server), ${JSON.stringify(
    cacheConfig,
  )});
}`);
};
