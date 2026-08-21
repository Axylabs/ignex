import { access, mkdir, readdir, readFile } from "node:fs/promises";
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

export async function writeFileEnsuringDir(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // `Bun.write` when running under Bun (~3.8x — docs/bun-internals.md).
  await bunWriteFile(path, data);
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
