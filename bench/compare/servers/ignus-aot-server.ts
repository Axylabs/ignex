#!/usr/bin/env bun
import { join } from "node:path";
/**
 * bench/compare/servers/ignus-aot-server.ts — AOT-compiled comparison
 * participant.
 *
 * Builds the bench app (`ignus-aot-app`) through the real AOT compiler
 * (`@ignex/compiler` `buildAsync` — same pipeline the production app uses),
 * then boots the generated `Bun.serve` entry on :9123.
 *
 * Run via `SERVER=ignus-aot bun run bench:compare:smoke` (opt-in — the AOT
 * participant is NOT part of the default bun/elysia/ignus run, so the CI gate
 * stays unchanged). The compiled route reply path (`ctx.json` → one
 * TextEncoder pass + exact content-length) is what this participant measures
 * against raw Bun.
 */
import { buildAsync } from "@ignex/compiler";

const appDir = join(import.meta.dir, "ignus-aot-app");
const outDir = join(appDir, "dist");

await buildAsync({
  routesDir: join(appDir, "src/routes"),
  hooksDir: undefined,
  appConfig: join(appDir, "src/app.config.ts"),
  outDir,
  outFile: "__server.js",
  target: "bun",

  optimizationLevel: 3,
  minify: false, // the bench measures runtime, not build output size
  sourceMap: false,

  enableAccessLog: false,
  enableTraceHeaders: false,

  generateTypes: false,
  generateOpenAPI: false,
  generateClient: false,

  specializeContext: true,
  hoistConstants: true,
  treeshakeRuntime: true,
  routeCache: true,

  precompileValidators: true,
  precompileSerializers: true,
});

console.log(`[ignus-aot] compiled → ${join(outDir, "__server.js")}`);

// Boot the compiled server: it calls `Bun.serve` on :9123 (from the bench
// app.config `server.port`) and keeps the event loop alive.
await import(join(outDir, "__server.js"));
