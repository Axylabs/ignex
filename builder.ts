import { build } from "./src/compiler/index";

build({
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

  router: "auto",
  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,

  specializeContext: true,
  hoistConstants: true,
  inlineHooks: true,
  treeshakeRuntime: true,
  routeCache: true,
});
