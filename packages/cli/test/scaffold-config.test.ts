/**
 * Scaffold config inherits optimized framework defaults and carries only
 * project-specific overrides, including SDK/OpenAPI extension points.
 */

import { expect, test } from "vitest";
import { ignexConfigTemplate } from "../src/templates/project.js";

test("ignexConfigTemplate emits a minimal typed override surface", () => {
  const config = ignexConfigTemplate();

  expect(config).toContain('import("@ignex/cli/config").IgnexProjectConfig');
  expect(config).toContain("export default {}");
  expect(config).not.toContain("optimizationLevel: 3");
  expect(config).not.toContain("precompileValidators: true");
  expect(config).not.toContain("generateOpenAPI: true");
  expect(config).not.toContain("routesDir:");
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
