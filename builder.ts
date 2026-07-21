import { buildAsync } from "./src/compiler/index";

await buildAsync({
  routesDir: "./src/routes",
  outDir: "./dist",
  outFile: "__server.js",
  target: "bun",

  optimizationLevel: 3,
  minify: true,
  sourceMap: false,

  enableTracing: false,
  enableAccessLog: false,
  enableStrictMethods: false,

  // Bun 1.4 native router
  router: "bun-native",

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