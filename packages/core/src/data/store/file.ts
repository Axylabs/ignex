/**
 * @fileoverview File store driver — a JSON-lines file-backed `Store`.
 *
 * A portable (`node:fs`) file store that persists entries as one JSON object
 * per line (`{ key, value, expiresAt }`) with atomic tmp+rename writes, so a
 * crash or concurrent reader can never observe a truncated file. Reads/writes
 * are synchronous (`readFileSync`/`writeFileSync`), mirroring the file job
 * store's approach for portability across Bun and Node.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveExpiry, type Store } from "./types";

/** Options for {@link createFileStore}. */
export interface FileStoreOptions {
  /** Default TTL in ms when `set()` omits `ttlMs` (default: no expiry). */
  ttlMs?: number;
  /** File name inside `dir` (default `store.jsonl`). */
  file?: string;
}

interface FileEntry {
  key: string;
  value: unknown;
  expiresAt: number; // 0 = never
}

/**
 * Create a JSON-lines file store.
 *
 * The whole store is kept in memory and rewritten to disk (tmp + atomic
 * rename) on every mutation; expired entries are skipped on read. `close()` is
 * a no-op (there are no timers or handles to release) but is provided for
 * interface parity.
 *
 * @param dir - Directory holding the store file (created if missing).
 * @param options - Default TTL + file name.
 * @returns The file store (see {@link Store}).
 */
export const createFileStore = (dir: string, options: FileStoreOptions = {}): Store => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, options.file ?? "store.jsonl");

  const entries = new Map<string, FileEntry>();

  const load = (): void => {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as FileEntry;
        if (entry && typeof entry.key === "string") entries.set(entry.key, entry);
      } catch {
        // Skip corrupt lines; the rest of the file stays usable.
      }
    }
  };

  const persist = (): void => {
    const tmp = `${file}.tmp`;
    const lines = [...entries.values()].map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(tmp, lines ? `${lines}\n` : "");
    renameSync(tmp, file);
  };

  load();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
        entries.delete(key);
        persist();
        return null;
      }
      return entry.value;
    },

    set(key, value, opts) {
      entries.set(key, {
        key,
        value,
        expiresAt: resolveExpiry(opts, options.ttlMs, Date.now()),
      });
      persist();
    },

    delete(key) {
      if (!entries.delete(key)) return;
      persist();
    },

    touch(key, opts) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.expiresAt = resolveExpiry(opts, options.ttlMs, Date.now());
      persist();
    },

    close() {
      // No timers or handles; kept for Store parity.
    },
  } satisfies Store;
};
