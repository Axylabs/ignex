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

  enableTracing: false,
  enableAccessLog: false,
  enableStrictMethods: false,


  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,

  specializeContext: true,
  hoistConstants: true,
  inlineHooks: true,
  treeshakeRuntime: true,
  routeCache: true,

  precompileValidators: true,
  precompileSerializers: true,
});
