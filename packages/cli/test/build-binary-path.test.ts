/**
 * `ignex build` must not own a copy of the binary output path rule.
 *
 * `build.ts` used to carry a private "mirror of the linker's ..." copy that
 * printed a different path than the linker wrote as soon as the rule changed.
 * The rule now lives in `@ignex/compiler` (`resolveBinaryOutPath`); this guard
 * fails if a local copy reappears.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const buildSource = readFileSync(
  fileURLToPath(new URL("../src/commands/build.ts", import.meta.url)),
  "utf8",
);

describe("ignex build binary path", () => {
  it("imports the rule from @ignex/compiler", () => {
    expect(buildSource).toMatch(
      /import \{[^}]*resolveBinaryOutPath[^}]*\} from "@ignex\/compiler";/,
    );
  });

  it("does not re-implement the rule locally", () => {
    expect(buildSource).not.toContain("const binaryPath");
    expect(buildSource).not.toContain("binaryOutfile ?");
    expect(buildSource).not.toMatch(/join\(opts\.outDir, opts\.serviceName/);
  });

  it("reports the path the linker will write", () => {
    expect(buildSource).toContain("resolveBinaryOutPath(opts)");
  });
});
