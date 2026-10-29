/**
 * @fileoverview Bun.build plugins used by the linker.
 *
 * Kept out of `linker.ts` (maintainability size cap):
 *   - `prodShapeBunPlugin` marks a production build and stubs the debugbar
 *     import so the dev-only dependency graph is tree-shaken away;
 *   - `runtimeDepPlugin` resolves deps the COMPILER emits into generated
 *     modules (serializer files import `fast-json-stringify`) from the
 *     compiler's own install, so an app never needs to hoist them.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { debugbarStubRewrite } from "./analysis/dev-only-plugins";

/** Specifiers the COMPILER emits into generated modules (serializer files). */
const COMPILER_RUNTIME_DEPS = ["fast-json-stringify"] as const;

/**
 * Bun.build plugin that resolves compiler-owned runtime deps from the
 * COMPILER's own install. Generated serializer modules live in the app's
 * output dir, so a bare `fast-json-stringify` import is unresolvable there —
 * it used to be externalized and then crash at boot in any app that did not
 * happen to hoist the compiler's dependency. The generated server's only
 * package dep must stay `@ignex/core`.
 */
export const runtimeDepPlugin = (): {
  name: string;
  setup: (build: { onResolve: (o: unknown, cb: (args: unknown) => unknown) => void }) => void;
} | null => {
  const paths: Record<string, string> = {};
  for (const spec of COMPILER_RUNTIME_DEPS) {
    try {
      const resolved = import.meta.resolve(spec);
      paths[spec] = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    } catch {
      // Leave it external; only builds that emit a precompiled serializer
      // will notice, and they surface the boot-time resolution error.
    }
  }
  const specs = Object.keys(paths);
  if (specs.length === 0) return null;
  const escaped = specs.map((spec) => spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const filter = new RegExp(`^(${escaped.join("|")})$`);

  return {
    name: "ignex-runtime-deps",
    setup(build) {
      build.onResolve({ filter }, (args: unknown) => {
        const spec = (args as { path?: string }).path ?? "";
        return paths[spec] !== undefined ? { path: paths[spec] } : undefined;
      });
    },
  };
};

/**
 * Bun.build loader plugin that PREPENDS `globalThis.__IGNEX_PROD_BUILD = true`
 * to the app-config module in production-shaped builds, and rewrites the
 * module's `debugbar` import bindings to inert local stubs so the bundler
 * treeshakes the entire debug graph (dashboard SPA, observatory endpoints,
 * TraceStore) out of the artifact.
 *
 * The assignment must live inside the app-config module itself (not the
 * generated entry header): ESM import hoisting evaluates the plugins array —
 * and with it every `debugbar(...)` factory call — before any entry-level
 * statement runs, so a header flag would always be set too late. Returns
 * `undefined` when the build is not production-shaped or no app config exists,
 * so the linker emits no plugin at all.
 */
export const prodShapeBunPlugin = (
  appConfigAbs: string,
  isProdBuild: boolean,
): {
  name: string;
  setup: (build: { onLoad: (o: unknown, cb: unknown) => void }) => void;
} | null => {
  if (!isProdBuild || !existsSync(appConfigAbs)) return null;
  return {
    name: "ignex-prod-shape",
    setup(build) {
      build.onLoad({ filter: /\.(ts|js|tsx|jsx|mts|mjs)$/ }, (args: { path: string }) => {
        if (args.path !== appConfigAbs) return undefined;
        const contents = readFileSync(args.path, "utf8");
        // Stub the dev-only plugin FIRST (offsets are relative to the raw
        // file), then prepend the runtime shape flag.
        const rewritten = debugbarStubRewrite(contents) ?? contents;
        return {
          contents: `globalThis.__IGNEX_PROD_BUILD = true;\n${rewritten}`,
          loader: "ts",
        };
      });
    },
  };
};
