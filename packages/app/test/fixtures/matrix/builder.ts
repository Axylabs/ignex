/**
 * AOT-compile the matrix fixture app used by the request-handling suites.
 *
 * Mirrors `packages/app/builder.ts`. Artifact generation (OpenAPI / client /
 * types) uses the compiler defaults (on), so `dist/client.ts` is available to
 * the compiled-code E2E suite. The build surface stays minimal because the
 * fixture only exercises runtime request handling plus the generated SDK.
 */
import { join } from "node:path";
import { buildAsync } from "@flux/compiler";

await buildAsync({
  routesDir: join(import.meta.dir, "src/routes"),
  outDir: join(import.meta.dir, "dist"),
  outFile: "__server.js",
  target: "bun",

  optimizationLevel: 3,
  minify: true,
  sourceMap: false,

  enableAccessLog: false,

  // Deterministic hardened error behavior (the framework default leaks real
  // messages when NODE_ENV !== "production"; the matrix pins the hardened
  // setting so error-envelope tests are stable regardless of environment).
  exposeErrorDetails: false,

  specializeContext: true,
  hoistConstants: true,
  treeshakeRuntime: true,
  routeCache: true,

  precompileValidators: true,
  precompileSerializers: true,
});
