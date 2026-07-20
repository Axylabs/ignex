import { build } from "./src/compiler/index";

build({
  routesDir: "./src/routes",
  outDir: "./dist",
  outFile: "__server.js",
  target: "bun",
  optimizationLevel: 3,
  enableTracing: false,
  enableAccessLog: false,
  enableStrictMethods: false,
  minify: true,
  sourceMap: false,
});