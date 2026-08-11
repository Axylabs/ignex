/**
 * @fileoverview Codegen: stage 1 — `@flux/core` import assembly + per-route
 * imports (handlers, validators, serializers, hooks, app config).
 */

import { existsSync } from "node:fs";
import type { CompilerOptions, HookDef, ModuleInfo, RouteDef } from "../../types";
import { projectPath } from "../../utils/path";
import { toImportPath } from "./config";
import { getInlineCandidate } from "./decisions";
import {
  handlerImportName,
  hookIdent,
  serializerImportName,
  validatorImportName,
} from "./identifiers";
import type { CodegenState } from "./state";

export const stageImports = (
  state: CodegenState,
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
): void => {
  const { imports, coreNames } = state;

  const appConfigPath = opts.appConfig;
  const appConfigAbs = appConfigPath ? projectPath(appConfigPath) : undefined;
  state.appConfigAbs = appConfigAbs;
  state.hasAppConfig =
    typeof appConfigPath === "string" &&
    appConfigPath.length > 0 &&
    (appConfigAbs ? existsSync(appConfigAbs) : false);

  coreNames.push(
    "createContext",
    "createLazyBody",
    "parseQueryFromURL",
    "errorToResponse",
    "sendFile",
    "HttpResponseCache",
    "ValidationError",
    "serializeCookie",
    "parseCookieString",
    "createCookieJar",
    "validateAsync",
    "EMPTY_LIFECYCLE",
    "runHooks",
  );

  if (state.hasAppConfig) {
    coreNames.push(
      "createPluginContext",
      "mergeLifeCycle",
      "pluginsToLifeCycle",
      "pluginContextToLifecycle",
    );
  }

  for (const route of routes) {
    if (route.usage.proxy) coreNames.push("proxyRequest");
    if (route.usage.forward) coreNames.push("forwardRequest");
  }

  state.uniqueCore = [...new Set(coreNames)].sort();

  if (state.hasAppConfig && appConfigAbs) {
    imports.add(
      `import * as __appConfig from ${JSON.stringify(toImportPath(appConfigAbs, opts))};`,
    );
  }

  // Handlers from fully self-contained modules are inlined instead of
  // imported, producing a more self-contained server entry.
  const inlineHandlers = state.inlineHandlers;

  for (const route of routes) {
    const mod = modules[route.moduleIdx];
    const inline = getInlineCandidate(route, mod, opts);
    if (inline) inlineHandlers.set(route.handlerRef, inline);

    if (mod && !inlineHandlers.has(route.handlerRef)) {
      const named = route.handlerExportName;
      const spec = named ? `{ ${named} as ${handlerImportName(route)} }` : handlerImportName(route);
      imports.add(`import ${spec} from ${JSON.stringify(toImportPath(mod.path, opts))};`);
      if (route.hasValidation) {
        imports.add(
          `import * as schema_${route.handlerRef} from ${JSON.stringify(
            toImportPath(mod.path, opts),
          )};`,
        );
      }
    }

    if (route.validators) {
      const kinds = ["body", "query", "params", "headers", "cookie"] as const;

      for (const kind of kinds) {
        if (route.validators[kind]) {
          imports.add(
            `import ${validatorImportName(
              route,
              kind,
            )} from "./validators/${route.handlerRef}.${kind}.cjs";`,
          );
        }
      }
    }

    if (route.serializers?.byStatus) {
      for (const [status, importName] of Object.entries(route.serializers.byStatus)) {
        imports.add(`import ${importName} from "./serializers/${route.handlerRef}.${status}.mjs";`);
      }
    } else if (route.serializers?.json) {
      imports.add(
        `import ${serializerImportName(route, "200")} from "./serializers/${route.handlerRef}.200.mjs";`,
      );
    }

    for (const hookName of route.hooks) {
      const hook = hooks.get(hookName);

      if (hook) {
        imports.add(
          `import ${hookIdent(hookName)} from ${JSON.stringify(toImportPath(hook.source, opts))};`,
        );
      }
    }
  }
};
