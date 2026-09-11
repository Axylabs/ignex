import { join } from "node:path";
import { buildAsync } from "@ignex/compiler";

// `bun builder.ts --compile [--binary-outfile NAME]` also emits a standalone
// executable (see `bun run compile` in package.json).
const args = process.argv.slice(2);
const compile = args.includes("--compile");
const binaryOutfileArg = args.indexOf("--binary-outfile");
const binaryOutfile = binaryOutfileArg >= 0 ? args[binaryOutfileArg + 1] : undefined;

await buildAsync({
  routesDir: join(import.meta.dir, "src/routes"),
  hooksDir: join(import.meta.dir, "src/hooks"),
  outDir: join(import.meta.dir, "dist"),
  outFile: "__server.js",
  target: "bun",

  optimizationLevel: 3,
  minify: true,
  sourceMap: false,

  // Production shape: eliminates the devbar/tracing instrumentation and bakes
  // `__IGNEX_PROD_BUILD` regardless of this process's NODE_ENV.
  production: true,

  enableAccessLog: false,

  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,

  specializeContext: true,
  hoistConstants: true,
  routeCache: true,

  precompileValidators: true,
  precompileSerializers: true,
  // Per-route native stack (`createNativeRoute`) — OFF.
  //
  // castrum 0.9.6 DOES ship the route-wire v3 surface (`castrum_route_*`, and
  // the optimized single-pass Rust parser: 2.4x on the 80-escape payload), so
  // enabling this no longer pays a dispatch cost for a JS fallback — the
  // earlier "the surface is missing below 0.10.0" note was wrong. It is still
  // OFF because it does not pay off END-TO-END on THIS app: measured with
  // castrum 0.9.6 (`bun scripts/bench-server.ts`, 7 routes, concurrency 32,
  // interleaved native-vs-fallback), native mode ran at PARITY with fallback
  // (native/fallback 0.97–1.04) with the native routes ON, versus a consistent
  // **+4–8% native advantage (1.02–1.08)** with them OFF. The app's routes are
  // small enough that the per-route native wrapper floor + wire decode are not
  // amortized, while the scalar C-ABI ops (`FFI_WINS`) still are. The native
  // route stack should be enabled PER-ROUTE for parse-heavy payloads (the
  // crossover is ~60 params / ~512B — see `docs/perf-methodology.md`), not as
  // a global flag; until the compiler can select per route, global OFF is the
  // measured best.
  nativeRoutes: true,

  ...(compile ? { compile: true, ...(binaryOutfile ? { binaryOutfile } : {}) } : {}),
});
