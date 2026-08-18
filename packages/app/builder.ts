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
  nativeRoutes: true,

  ...(compile ? { compile: true, ...(binaryOutfile ? { binaryOutfile } : {}) } : {}),
});
