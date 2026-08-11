import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface FixtureLayout {
  routesDir: string;
  outDir: string;
}

/**
 * Copy a committed fixture directory into a fresh temp dir so builds never
 * write into the repository.
 */
export const materializeFixture = (name: string): FixtureLayout => {
  const outDir = mkdtempSync(join(tmpdir(), "ignus-compiler-"));
  const routesDir = join(outDir, "routes");
  mkdirSync(routesDir, { recursive: true });
  cpSync(join(fixturesDir, name), routesDir, { recursive: true });
  return { routesDir, outDir };
};

/** Absolute path of a committed fixture file (e.g. an app config). */
export const fixturePath = (name: string, file: string): string => join(fixturesDir, name, file);
