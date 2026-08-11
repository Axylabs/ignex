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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseResult } from "../utils/ast/parse";
import { hashString } from "../utils/hash";
import type { SourceFile } from "./source-file";

const MODULES_CACHE_VERSION = "1";
const MODULES_CACHE_FILE = ".ignus-modules.json";

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
  writeFileSync(modulesCachePath(outDir), serializeSourceFiles(sources));
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
      if (record && typeof record.hash === "string" && record.parse) {
        map.set(record.hash, record.parse);
      }
    }
    return map;
  } catch {
    return new Map();
  }
};
