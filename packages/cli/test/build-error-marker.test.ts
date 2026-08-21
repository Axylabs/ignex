/**
 * `writeBuildErrorMarker` — the dev build-error marker behind the overlay.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBuildErrorMarker } from "../src/utils/compiler.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("writeBuildErrorMarker", () => {
  it("writes a structured marker on failure and clears it on success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-marker-"));
    dirs.push(dir);

    await writeBuildErrorMarker(dir, "SyntaxError: boom");
    const marker = join(dir, ".ignex-build-error.json");
    expect(existsSync(marker)).toBe(true);
    const parsed = JSON.parse(readFileSync(marker, "utf-8")) as { message: string };
    expect(parsed.message).toBe("SyntaxError: boom");

    await writeBuildErrorMarker(dir, null);
    expect(existsSync(marker)).toBe(false);
  });
});
