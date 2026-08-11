import { join } from "node:path";
import { buildAsync } from "@ignus/compiler";

await buildAsync({
  routesDir: join(import.meta.dir, "src/routes"),
  hooksDir: join(import.meta.dir, "src/hooks"),
  outDir: join(import.meta.dir, "dist"),
  outFile: "__server.js",
  target: "bun",

  optimizationLevel: 3,
  minify: true,
  sourceMap: false,

  enableAccessLog: false,

  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,

  specializeContext: true,
  hoistConstants: true,
  treeshakeRuntime: true,
  routeCache: true,

  precompileValidators: true,
  precompileSerializers: true,
});
