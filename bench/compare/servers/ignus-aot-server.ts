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

  // `BENCH_SPECIALIZE=0` forces every route onto the FULL context instead of the
  // usage-specialized tier.
  //
  // The harness rebuilds this app on EVERY run (`cpu.ts` → `buildAot()`), so an
  // artifact swap cannot A/B anything — the switch has to live here, at the
  // build site. This is the only way to price the two tiers honestly: the SAME
  // app, the SAME compiler, the SAME options, one flag flipped. Anything that
  // swaps artifacts or compares across compiler versions measures the harness,
  // not the change.
  specializeContext: process.env.BENCH_SPECIALIZE !== "0",
  hoistConstants: true,
  routeCache: true,

  precompileValidators: true,
  precompileSerializers: true,

  // Match the production app (`packages/app/builder.ts`): the per-route native
  // stack (`createNativeRoute`) is measured as a net loss on small routes (+4-8%
  // for the fallback path, see docs/perf-methodology.md), so the bench
  // participant must not measure a configuration the framework does not ship.
  nativeRoutes: false,
});

console.log(`[ignus-aot] compiled → ${join(outDir, "__server.js")}`);

// Build-only mode: emit the artifact and exit WITHOUT booting it.
//
// The CPU-per-request bench (`bench/compare/cpu.ts`) uses this to build once,
// then measures the compiled artifact in a clean process. Booting from THIS
// file keeps the whole compiler + bundler resident in the server's heap, which
// measurably inflates per-request GC (measured 35.4us/req vs ~29.9us/req for
// the same compiled entry spawned alone — a ~18% penalty that has nothing to
// do with the framework's runtime).
if (process.env.BENCH_BUILD_ONLY === "1") {
  process.exit(0);
}

// Boot the compiled server: it calls `Bun.serve` on :9123 (from the bench
// app.config `server.port`) and keeps the event loop alive.
await import(join(outDir, "__server.js"));
