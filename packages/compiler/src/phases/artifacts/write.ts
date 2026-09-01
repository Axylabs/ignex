/**
 * @fileoverview Artifact writing — guarded file writes + the `writeArtifacts`
 * orchestrator.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticCodes, errorMessage } from "../../diagnostics";
import type { CompilerContext, CompilerOptions, ModuleInfo, RouteIR } from "../../types";
import { generateClient, generateClientDts } from "./client";
import { generateManifest } from "./manifest";
import { generateOpenApi } from "./openapi";
import { generateRouteTypes } from "./route-types";

/**
 * Write `content` to `file` ONLY when it differs from what is on disk.
 * Rewriting byte-identical artifacts churns mtimes on every rebuild — which
 * wakes watchers, invalidates downstream caches, and makes builds look
 * dirtier than they are. Returns `true` when a write happened.
 */
export const writeIfChanged = (file: string, content: string): boolean => {
  try {
    const stat = statSync(file);
    if (stat.isFile() && readFileSync(file, "utf-8") === content) return false;
  } catch {
    // Missing/unreadable — fall through and write.
  }
  writeFileSync(file, content);
  return true;
};

/**
 * Write a generated artifact (content-diffed), reporting a diagnostic on
 * failure instead of throwing (so one bad artifact never aborts the build).
 */
export const writeGuarded = (
  file: string,
  content: string,
  ctx: CompilerContext,
  label: string,
): void => {
  try {
    if (!writeIfChanged(file, content)) return;
    ctx.logger.info(`Generated ${label}`);
  } catch (error) {
    ctx.diagnostics.error({
      code: DiagnosticCodes.ArtifactWriteFailed,
      message: `Failed to write ${label}: ${errorMessage(error)}`,
      file,
    });
  }
};

/**
 * Write every requested artifact (routes.d.ts, client.ts/d.ts, openapi.json,
 * manifest.json) into `opts.outDir`. Each write is guarded — failures become
 * diagnostics rather than throwing.
 *
 * `modules` feeds the typed-body emission in `routes.d.ts` (a route module
 * exporting a TypeBox `schema` const yields `Static<typeof schema.body>`).
 */
export const writeArtifacts = (
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  ctx: CompilerContext,
): void => {
  mkdirSync(opts.outDir, { recursive: true });

  if (opts.generateTypes) {
    const types = generateRouteTypes(routes, modules, opts);
    writeGuarded(join(opts.outDir, "routes.d.ts"), types, ctx, "routes.d.ts");
  }

  if (opts.generateClient) {
    writeGuarded(join(opts.outDir, "client.d.ts"), generateClientDts(), ctx, "client.d.ts");
    writeGuarded(join(opts.outDir, "client.ts"), generateClient(routes), ctx, "client.ts");
  }

  if (opts.generateOpenAPI) {
    const openapi = generateOpenApi(routes, opts);
    writeGuarded(
      join(opts.outDir, "openapi.json"),
      JSON.stringify(openapi, null, 2),
      ctx,
      "openapi.json",
    );
  }

  const manifest = generateManifest(routes, opts);
  writeGuarded(
    join(opts.outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    ctx,
    "manifest.json",
  );
};
