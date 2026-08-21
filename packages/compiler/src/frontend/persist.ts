/**
 * Persistent per-module parse cache (across builds).
 *
 * A full build parses every route module exactly once into a `ParseResult`
 * (AST included). On a later incremental-cache hit that still regenerates
 * artifacts (discovery → analysis → optimization → artifacts), we rehydrate
 * those `ParseResult`s from disk instead of re-parsing source —
 * `SourceManager` consults this cache before calling `parseModule`.
 *
 * Records are keyed by content hash, so an edited file naturally misses and
 * falls back to a fresh parse (genuine incremental parsing on full rebuilds).
 * Bump {@link MODULES_CACHE_VERSION} whenever the persisted shape changes so
 * stale records are discarded instead of mis-rehydrated.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseResult } from "../utils/ast/parse";
import { hashString } from "../utils/hash";
import type { SourceFile } from "./source-file";

const MODULES_CACHE_VERSION = "4";
const MODULES_CACHE_FILE = ".ignex-modules.json";

interface PersistedModule {
  readonly hash: string;
  readonly relPath: string;
  readonly content: string;
  readonly parse: ParseResult;
}

interface PersistedModulesFile {
  readonly version: string;
  readonly modules: PersistedModule[];
}

export const modulesCachePath = (outDir: string): string => join(outDir, MODULES_CACHE_FILE);

/**
 * Serialize retained source files into the disk-cache JSON. Each record is
 * keyed by content hash so a changed file misses on rehydration.
 */
export const serializeSourceFiles = (sources: readonly SourceFile[]): string => {
  const file: PersistedModulesFile = {
    version: MODULES_CACHE_VERSION,
    modules: sources.map((s) => ({
      hash: hashString(s.content),
      relPath: s.relPath,
      content: s.content,
      parse: s.parse,
    })),
  };
  return JSON.stringify(file);
};

/** Write the module cache next to the build outputs (best-effort). */
export const persistModules = (sources: readonly SourceFile[], outDir: string): void => {
  // Atomic write (temp + rename) so a crash mid-write can never leave a
  // truncated .json that `loadPersistedModules` half-parses — mirrors the
  // build-cache write in cache.ts.
  const path = modulesCachePath(outDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeSourceFiles(sources));
  renameSync(tmp, path);
};

/**
 * Load the module cache as a `contentHash → ParseResult` map. Returns an empty
 * map when the file is missing, corrupt, or from an incompatible version —
 * callers then parse from source as usual.
 */
export const loadPersistedModules = (outDir: string): Map<string, ParseResult> => {
  const path = modulesCachePath(outDir);
  if (!existsSync(path)) return new Map();

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PersistedModulesFile;
    if (!parsed || !Array.isArray(parsed.modules) || parsed.version !== MODULES_CACHE_VERSION) {
      return new Map();
    }

    const map = new Map<string, ParseResult>();
    for (const record of parsed.modules) {
      // Integrity check: the claimed content hash must match the embedded
      // content, else a tampered-but-valid-JSON file could rehydrate a
      // ParseResult mismatched to the real source → silent miscompile. Records
      // are content-hash-keyed at lookup, so a mismatch here is dropped.
      if (
        record &&
        typeof record.hash === "string" &&
        typeof record.content === "string" &&
        record.parse &&
        record.hash === hashString(record.content)
      ) {
        map.set(record.hash, record.parse);
      }
    }
    return map;
  } catch {
    return new Map();
  }
};
