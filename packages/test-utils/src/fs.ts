/**
 * @fileoverview Filesystem helpers for tests: materializing fixture file-sets
 * into throwaway temp dirs (so tests never write into the repo) and cleaning
 * up afterwards. Mirrors `packages/compiler/test/helpers.ts`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TmpWorkspace {
  /** Absolute path of the throwaway directory. */
  dir: string;
  /** Write one file (creating parent dirs). Returns the absolute path. */
  write(relPath: string, content: string): Promise<string>;
  /** Remove the whole directory. */
  cleanup(): Promise<void>;
}

/** Create a throwaway temp workspace under the OS tmp dir. */
export const tmpWorkspace = async (prefix = "ignex-test-"): Promise<TmpWorkspace> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    async write(relPath, content) {
      const abs = join(dir, relPath);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content, "utf8");
      return abs;
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/** Materialize a flat or nested `{ "dir/file.ts": "content" }` map into tmp. */
export const materializeFiles = async (
  files: Record<string, string>,
  prefix = "ignex-fixture-",
): Promise<TmpWorkspace> => {
  const ws = await tmpWorkspace(prefix);
  for (const [relPath, content] of Object.entries(files)) {
    await ws.write(relPath, content);
  }
  return ws;
};
