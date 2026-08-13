/**
 * @fileoverview Artifact writing — guarded file writes + the `writeArtifacts`
 * orchestrator.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticCodes, errorMessage } from "../../diagnostics";
import type { CompilerContext, CompilerOptions, RouteIR } from "../../types";
import { generateClient, generateClientDts } from "./client";
import { generateManifest } from "./manifest";
import { generateOpenApi } from "./openapi";
import { generateRouteTypes } from "./route-types";

export const writeGuarded = (
  file: string,
  content: string,
  ctx: CompilerContext,
  label: string,
): void => {
  try {
    writeFileSync(file, content);
    ctx.logger.info(`Generated ${label}`);
  } catch (error) {
    ctx.diagnostics.error({
      code: DiagnosticCodes.ArtifactWriteFailed,
      message: `Failed to write ${label}: ${errorMessage(error)}`,
      file,
    });
  }
};

export const writeArtifacts = (
  routes: readonly RouteIR[],
  opts: CompilerOptions,
  ctx: CompilerContext,
): void => {
  mkdirSync(opts.outDir, { recursive: true });

  if (opts.generateTypes) {
    const types = generateRouteTypes(routes);
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
