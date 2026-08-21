/**
 * @fileoverview Bun builtin compatibility layer for the CLI.
 *
 * The CLI is the repo's only dual-runtime package (engines node+bun, typed
 * with `@types/node` / `types: ["node"]`), so it never references the `Bun`
 * global directly. These helpers feature-detect `globalThis.Bun` ONCE and use
 * Bun's native builtins when the CLI is actually running under Bun, falling
 * back to the Node equivalent otherwise — keeping the package typecheckable
 * without bun-types (structural casts, same pattern as
 * `packages/native/src/bun.ts`).
 *
 * Benchmark evidence lives in `docs/bun-internals.md`:
 *   - `Bun.write` ~3.8x faster than `node:fs/promises writeFile`
 *   - `Bun.spawnSync` ~1.19x faster than `node:child_process spawnSync`
 *   - `crypto.getRandomValues` ~87x faster than `node:crypto randomBytes`
 *
 * Note: `spawnSync` call sites that need Node-specific results (`error`,
 * `shell`, `stdio: "inherit"`) intentionally stay on `node:child_process` —
 * those shapes don't map to `Bun.spawnSync` and run once per scaffold.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

interface BunCompatSurface {
  write(path: string, data: string): Promise<number>;
  spawnSync(
    cmds: readonly string[],
    options?: {
      cwd?: string;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
    },
  ): { exitCode: number | null };
}
const B = (globalThis as { Bun?: BunCompatSurface }).Bun;
const bunWrite = B?.write;
const bunSpawnSync = B?.spawnSync;
const globalCrypto = globalThis as {
  crypto?: { getRandomValues<T extends ArrayBufferView | null>(array: T): T };
};

/** Write `data` to `path` (utf8), preferring `Bun.write` under Bun (~3.8x). */
export async function bunWriteFile(path: string, data: string): Promise<void> {
  if (bunWrite) {
    await bunWrite(path, data);
    return;
  }
  await writeFile(path, data, "utf8");
}

/** `true` when `command` resolves on PATH and its `--version` invocation succeeds. */
export function commandExistsBun(command: string): boolean {
  try {
    if (bunSpawnSync) {
      const result = bunSpawnSync([command, "--version"], { stdout: "ignore", stderr: "ignore" });
      return result.exitCode === 0;
    }
    return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * `n` CSPRNG bytes — `crypto.getRandomValues` (webcrypto, native in Bun and
 * Node ~87x vs `randomBytes` — see `docs/bun-internals.md`), with a
 * `node:crypto` fallback for environments without the webcrypto global.
 */
export function secureRandomBytes(n: number): Buffer {
  if (globalCrypto.crypto?.getRandomValues) {
    const bytes = new Uint8Array(n);
    globalCrypto.crypto.getRandomValues(bytes);
    return Buffer.from(bytes);
  }
  return randomBytes(n);
}
