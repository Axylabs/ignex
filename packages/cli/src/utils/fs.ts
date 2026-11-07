import { access, chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { bunWriteFile } from "./bun-compat.js";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `data` to `path`, creating parent directories, optionally setting the
 * file mode afterwards. `mode` is only applied when provided (e.g. `0o755`
 * for scaffolded shell scripts) — the default keeps the process umask.
 */
export async function writeFileEnsuringDir(
  path: string,
  data: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // `Bun.write` when running under Bun (~3.8x — docs/native-acceleration.md).
  await bunWriteFile(path, data);
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function isDirEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
  } catch {
    return true;
  }
}
