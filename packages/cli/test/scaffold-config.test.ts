/**
 * Scaffold template tests — the generated `ignex.config.mjs` must carry the
 * production optimization profile (parity with packages/app/builder.ts) so a
 * fresh `ignex create` project gets the tuned defaults, not the compiler's
 * raw defaults.
 */

import { expect, test } from "vitest";
import { ignexConfigTemplate } from "../src/templates/project.js";

test("ignexConfigTemplate emits the production optimization profile", () => {
  const config = ignexConfigTemplate();

  expect(config).toContain("optimizationLevel: 3");
  expect(config).toContain("precompileValidators: true");
  expect(config).toContain("precompileSerializers: true");
  expect(config).toContain("generateTypes: true");
  expect(config).toContain("generateOpenAPI: true");
  expect(config).toContain("generateClient: true");
  expect(config).toContain("specializeContext: true");
  expect(config).toContain("hoistConstants: true");
  expect(config).toContain("routeCache: true");
  expect(config).toContain('routesDir: "src/routes"');
  expect(config).toContain('outFile: "server.js"');
});

test("dev help text documents --minify and --sourcemap", async () => {
  const { loadCommand } = await import("../src/commands/loaders.js");
  const { renderCommandHelp } = await import("../src/usage.js");
  const dev = await loadCommand("dev");
  expect(dev).toBeDefined();
  const help = await renderCommandHelp(dev as never);
  expect(help).toContain("--minify");
  expect(help).toContain("--sourcemap");
});
