/**
 * @fileoverview Codegen: stage 1 — app-config wiring + per-route imports
 * (handlers, validators, serializers, hooks).
 *
 * The `@ignex/core` import is assembled once in `server.ts` (structural
 * symbols + `state.usedCore`); the linker's bundler prunes whatever turns out
 * unused. This stage only emits per-route module imports.
 */

import { existsSync } from "node:fs";
import type { AppConfigInfo, CompilerOptions, HookDef, ModuleInfo, RouteIR } from "../../types";
import { SCHEMA_PARTS } from "../../types";
import { projectPath } from "../../utils/path";
import { toImportPath } from "./config";
import {
  handlerImportName,
  hookIdent,
  serializerImportName,
  validatorImportName,
  wsHandlerImportName,
} from "./identifiers";
import { configImportName } from "./routes/reply";
import type { CodegenState } from "./state";

/** Resolve the app-config path to an absolute path, or `undefined` when unset. */
const resolveAppConfigPath = (appConfigPath: string | undefined): string | undefined => {
  if (typeof appConfigPath !== "string" || appConfigPath.length === 0) return undefined;
  return projectPath(appConfigPath);
};

/** Import a WS route's `wsHandler` export for the server's `websocket` option. */
const emitWsImport = (
  state: CodegenState,
  route: RouteIR,
  mod: ModuleInfo | undefined,
  opts: CompilerOptions,
): void => {
  if (!mod) return;
  state.imports.add(
    `import { wsHandler as ${wsHandlerImportName(route)} } from ${JSON.stringify(toImportPath(mod.path, opts))};`,
  );
  state.wsHandlers.push({ path: route.source.path, handler: wsHandlerImportName(route) });
};

/** Import a route's HTTP handler (plus its schema when it validates). */
const emitHandlerImport = (
  state: CodegenState,
  route: RouteIR,
  mod: ModuleInfo,
  opts: CompilerOptions,
): void => {
  const named = route.analysis.handlerExportName;
  const spec = named ? `{ ${named} as ${handlerImportName(route)} }` : handlerImportName(route);
  state.imports.add(`import ${spec} from ${JSON.stringify(toImportPath(mod.path, opts))};`);
  if (route.analysis.hasValidation) {
    state.imports.add(
      `import * as schema_${route.codegen.handlerRef} from ${JSON.stringify(toImportPath(mod.path, opts))};`,
    );
  }
  // The route's `config` export carries the runtime before/after chains when
  // present (the compiler reads `cfg?.before/after` at module scope). Only
  // emitted for modules that actually export `config` — an ESM named import
  // of a missing export would fail at load, so this is strictly flag-gated.
  if (route.analysis.configExport) {
    state.imports.add(
      `import { config as ${configImportName(route)} } from ${JSON.stringify(toImportPath(mod.path, opts))};`,
    );
  }
};

/** Import the generated per-part validators a route needs. */
const emitValidatorImports = (route: RouteIR, imports: Set<string>): void => {
  if (!route.decisions.validators) return;
  const kinds = SCHEMA_PARTS;
  for (const kind of kinds) {
    if (route.decisions.validators[kind]) {
      imports.add(
        `import ${validatorImportName(route, kind)} from "./validators/${route.codegen.handlerRef}.${kind}.cjs";`,
      );
    }
  }
};

/** Import the generated serializers a route needs. */
const emitSerializerImports = (route: RouteIR, imports: Set<string>): void => {
  const serializers = route.decisions.serializers;
  if (serializers?.byStatus) {
    for (const [status, importName] of Object.entries(serializers.byStatus)) {
      imports.add(
        `import ${importName} from "./serializers/${route.codegen.handlerRef}.${status}.mjs";`,
      );
    }
  } else if (serializers?.json) {
    imports.add(
      `import ${serializerImportName(route, "200")} from "./serializers/${route.codegen.handlerRef}.200.mjs";`,
    );
  }
};

/** Import the hook modules a route registers. */
const emitHookImports = (
  route: RouteIR,
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
  imports: Set<string>,
): void => {
  for (const hookName of route.analysis.hooks) {
    const hook = hooks.get(hookName);
    if (hook) {
      imports.add(
        `import ${hookIdent(hookName)} from ${JSON.stringify(toImportPath(hook.source, opts))};`,
      );
    }
  }
};

export const stageImports = (
  state: CodegenState,
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
  appConfig?: AppConfigInfo,
  realtimeConsumers: readonly string[] = [],
): void => {
  const { imports } = state;

  const appConfigAbs = resolveAppConfigPath(opts.appConfig);
  state.appConfigAbs = appConfigAbs;
  state.hasAppConfig = appConfigAbs !== undefined && existsSync(appConfigAbs);
  // A config that only sets `server` carries no per-request hooks — those apps
  // can still specialize/hoist. When the config wasn't analyzed (e.g. direct
  // `generateServer` callers), conservatively treat its presence as hooks.
  state.appConfigHasHooks = appConfig
    ? appConfig.hasActivePlugins || appConfig.hasLifecycle
    : state.hasAppConfig;
  state.traceDebug = appConfig ? appConfig.hasEnabledDebugbar : false;
  state.isProductionBuild = appConfig ? appConfig.isProductionBuild : false;

  if (state.hasAppConfig && appConfigAbs) {
    imports.add(
      `import * as __appConfig from ${JSON.stringify(toImportPath(appConfigAbs, opts))};`,
    );
  }

  // Handlers from fully self-contained modules are inlined instead of
  // imported, producing a more self-contained server entry. The inline
  // candidates were resolved by the optimization phase — codegen only reads
  // the finalized decision.
  const inlineHandlers = state.inlineHandlers;

  for (const route of routes) {
    const mod = modules[route.source.moduleIdx];

    // WebSocket routes import their `wsHandler` export for the server's
    // `websocket` option; they have no HTTP handler to inline or import.
    if (route.source.method === "WS") {
      emitWsImport(state, route, mod, opts);
      continue;
    }

    const inline = route.decisions.inlineCandidate;
    if (inline) inlineHandlers.set(route.codegen.handlerRef, inline);

    if (mod && !inlineHandlers.has(route.codegen.handlerRef)) {
      emitHandlerImport(state, route, mod, opts);
    }

    emitValidatorImports(route, imports);
    emitSerializerImports(route, imports);
    emitHookImports(route, hooks, opts, imports);
  }

  // Realtime consumers are imported so the header stage can call each one's
  // default-exported `register()` after novaPlugin init (the events hub is
  // bound by then). They are plain modules — not routes, not analyzed.
  let consumerIdx = 0;
  for (const consumer of realtimeConsumers) {
    const ref = `__realtimeConsumer_${consumerIdx++}`;
    imports.add(`import ${ref} from ${JSON.stringify(toImportPath(consumer, opts))};`);
    state.realtimeConsumerRefs.push(ref);
  }
};
