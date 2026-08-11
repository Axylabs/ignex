/**
 * Scaffold template tests — the generated `ignus.config.mjs` must carry the
 * production optimization profile (parity with packages/app/builder.ts) so a
 * fresh `ignus create` project gets the tuned defaults, not the compiler's
 * raw defaults.
 */

import { expect, test } from "vitest";
import { ignusConfigTemplate } from "../src/templates/project.js";

test("ignusConfigTemplate emits the production optimization profile", () => {
  const config = ignusConfigTemplate();

  expect(config).toContain("optimizationLevel: 3");
  expect(config).toContain("precompileValidators: true");
  expect(config).toContain("precompileSerializers: true");
  expect(config).toContain("generateTypes: true");
  expect(config).toContain("generateOpenAPI: true");
  expect(config).toContain("generateClient: true");
  expect(config).toContain("specializeContext: true");
  expect(config).toContain("hoistConstants: true");
  expect(config).toContain("treeshakeRuntime: true");
  expect(config).toContain("routeCache: true");
  expect(config).toContain('routesDir: "src/routes"');
  expect(config).toContain('outFile: "server.js"');
});

test("dev help text documents --minify and --sourcemap", async () => {
  const { commands, renderHelp } = await import("../src/commands/registry.js");
  const dev = commands.find((c) => c.name === "dev");
  expect(dev?.options).toContain("--minify");
  expect(dev?.options).toContain("--sourcemap");
  expect(renderHelp()).toContain("--minify");
});
