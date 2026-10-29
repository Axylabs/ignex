/**
 * `resolveBinaryOutPath` — the single definition of where a `--compile`
 * standalone binary lands.
 *
 * `ignex build` prints this path in its status line while the linker writes
 * the file. The two used to hold private copies of the rule and drifted; the
 * parity block below keeps them on the compiler's implementation.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBinaryOutPath } from "../src";

const outDir = join("/tmp", "app", "dist");

describe("resolveBinaryOutPath", () => {
  it("defaults to outDir/serviceName", () => {
    expect(resolveBinaryOutPath({ outDir, serviceName: "reports" })).toBe(join(outDir, "reports"));
  });

  it("defaults to outDir/ignex when there is no service name", () => {
    expect(resolveBinaryOutPath({ outDir })).toBe(join(outDir, "ignex"));
  });

  it("roots a relative binaryOutfile under outDir", () => {
    expect(resolveBinaryOutPath({ outDir, binaryOutfile: "server" })).toBe(join(outDir, "server"));
  });

  it("respects a relative binaryOutfile over the service name", () => {
    expect(resolveBinaryOutPath({ outDir, serviceName: "reports", binaryOutfile: "custom" })).toBe(
      join(outDir, "custom"),
    );
  });

  it("passes an absolute binaryOutfile through untouched", () => {
    const absolute = join("/", "opt", "bin", "ignex-server");
    expect(resolveBinaryOutPath({ outDir, serviceName: "reports", binaryOutfile: absolute })).toBe(
      absolute,
    );
  });

  it("is not confused by a binaryOutfile that merely looks rooted", () => {
    // `~` and `..` are not absolute: they stay rooted under outDir.
    expect(resolveBinaryOutPath({ outDir, binaryOutfile: "~/bin/app" })).toBe(
      join(outDir, "~/bin/app"),
    );
    expect(resolveBinaryOutPath({ outDir, binaryOutfile: "../app" })).toBe(join(outDir, "../app"));
  });
});
