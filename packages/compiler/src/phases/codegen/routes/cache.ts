/**
 * @fileoverview Codegen: response-cache wrapper emission.
 */

import type { RouteIR } from "../../../types";
import type { CacheOptions } from "../decisions";
import { cacheOptsVar, cacheVar, methodHandlerName } from "../identifiers";
import type { CodegenState } from "../state";

/**
 * Emit the cache variable and the outer handler that serves/refreshes it.
 * The core handler (passed by name) does the actual work.
 */
export const emitCacheWrapper = (
  state: CodegenState,
  route: RouteIR,
  cacheConfig: CacheOptions,
  coreName: string,
): void => {
  state.usedCore.add("HttpResponseCache");
  state.cacheDecls.push(
    `const ${cacheVar(route)} = new HttpResponseCache(${JSON.stringify({
      max: 1000,
      ...cacheConfig,
    })});`,
  );

  state.functions.push(`const ${cacheOptsVar(route)} = ${JSON.stringify(cacheConfig)};
function ${methodHandlerName(route)}(req, params, server) {
  return ${cacheVar(route)}.getOrSet(req, () => ${coreName}(req, params, server), ${cacheOptsVar(route)});
}`);
};
