/**
 * @fileoverview Incremental build cache.
 *
 * A lightweight content-hash cache: when none of the build inputs changed
 * (route files, app config, hooks, effective options, compiler version), the
 * previous build outputs are reused and the whole pipeline is skipped.
 *
 * This is a whole-build "no-op" cache (like most framework build caches), NOT
 * parse-level incremental compilation. Parse-level incremental builds are
 * future work.
 *
 * Uses `node:fs/promises` for portability across Bun and Node runtimes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { DiagnosticCodes, errorMessage } from "./diagnostics";
import type { CompilerContext, CompilerOptions, OptimizationMeta } from "./types";
import { hashString } from "./utils/hash";
import { projectPath } from "./utils/path";

/**
 * Bump when the generated output format changes so stale caches are
 * invalidated even if inputs are identical.
 */
const COMPILER_CACHE_VERSION = "0.5.0";

const CACHE_FILE = ".flux-cache.json";

interface CacheRecord {
  readonly version: string;
  readonly fingerprint: string;
  readonly outFile: string;
  readonly timestamp: string;
  readonly meta?: OptimizationMeta;
}

const listFiles = (dir: string, base = ""): string[] => {
  const out: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;

    const abs = join(dir, entry);
    const rel = join(base, entry).replace(/\\/g, "/");

    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      out.push(...listFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }

  return out;
};

const hashFile = (absPath: string): string => {
  try {
    const content = readFileSync(absPath, "utf-8");
    const stat = statSync(absPath);
    return `${hashString(content)}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
};

const stableOptions = (opts: CompilerOptions): string => {
  const keys = Object.keys(opts).sort();
  const parts: string[] = [];

  for (const key of keys) {
    const value = (opts as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    parts.push(`${key}=${JSON.stringify(value)}`);
  }

  return parts.join("&");
};

/**
 * Resolve the on-disk `@flux/core` package directory so its shipped source can
 * be fingerprinted. The linker bundles `@flux/core` into the output, so a core
 * source change must invalidate the cache even when routes/hooks/config are
 * unchanged.
 */
const corePackageDir = (): string | undefined => {
  const req = createRequire(import.meta.url);

  // Installed layout: node_modules/@flux/core/package.json (via exports).
  try {
    return dirname(req.resolve("@flux/core/package.json"));
  } catch {
    // Workspace/source layout (no node_modules symlinks): resolve the main
    // entry (<root>/src/index.ts) and climb to the package root.
    try {
      const entry = req.resolve("@flux/core");
      const root = dirname(dirname(entry)); // <root>/src → <root>
      return existsSync(join(root, "package.json")) ? root : undefined;
    } catch {
      return undefined;
    }
  }
};

export const computeFingerprint = (opts: CompilerOptions): string => {
  const chunks: string[] = [COMPILER_CACHE_VERSION, stableOptions(opts)];

  const hashDir = (dir: string) => {
    for (const rel of listFiles(dir)) {
      chunks.push(`${rel}:${hashFile(join(dir, rel))}`);
    }
  };

  if (opts.routesDir && existsSync(opts.routesDir)) {
    hashDir(opts.routesDir);
  }

  if (opts.hooksDir && existsSync(opts.hooksDir)) {
    hashDir(opts.hooksDir);
  }

  if (opts.appConfig) {
    chunks.push(`appConfig:${hashFile(projectPath(opts.appConfig))}`);
  }

  const core = corePackageDir();
  if (core && existsSync(core)) {
    chunks.push(`core:${hashFile(join(core, "package.json"))}`);
    const coreSrc = join(core, "src");
    if (existsSync(coreSrc)) {
      for (const rel of listFiles(coreSrc)) {
        chunks.push(`core/src/${rel}:${hashFile(join(coreSrc, rel))}`);
      }
    }
  }

  return hashString(chunks.join("\n"));
};

const cachePath = (opts: CompilerOptions): string => join(opts.outDir, CACHE_FILE);

const readCache = (opts: CompilerOptions): CacheRecord | undefined => {
  const file = cachePath(opts);
  if (!existsSync(file)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as CacheRecord;
    return parsed && parsed.version === COMPILER_CACHE_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Returns the cached build (code + outFile) when inputs are unchanged and the
 * previous output still exists on disk, otherwise `undefined`.
 */
export const tryCachedBuild = async (
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<{ code: string; outFile: string; meta?: OptimizationMeta } | undefined> => {
  try {
    const record = readCache(opts);
    if (!record) return undefined;

    const fingerprint = computeFingerprint(opts);
    if (record.fingerprint !== fingerprint) return undefined;

    const outFile = join(opts.outDir, record.outFile);
    if (!existsSync(outFile)) return undefined;

    const code = await readFile(outFile, "utf-8");
    ctx.logger.info(`Incremental cache hit — skipping build (${record.outFile}).`);

    return { code, outFile, ...(record.meta ? { meta: record.meta } : {}) };
  } catch (error) {
    ctx.diagnostics.warn({
      code: DiagnosticCodes.BuildCacheInvalid,
      message: `Build cache could not be read: ${errorMessage(error)}`,
    });
    return undefined;
  }
};

/** Persist the current build's fingerprint so the next build can be skipped. */
export const storeCache = async (
  opts: CompilerOptions,
  ctx: CompilerContext,
  outPath: string,
  meta?: OptimizationMeta,
): Promise<void> => {
  try {
    const record: CacheRecord = {
      version: COMPILER_CACHE_VERSION,
      fingerprint: computeFingerprint(opts),
      outFile: relative(opts.outDir, outPath).replace(/\\/g, "/"),
      timestamp: new Date().toISOString(),
      ...(meta ? { meta } : {}),
    };

    await writeFile(cachePath(opts), JSON.stringify(record, null, 2));
  } catch (error) {
    ctx.diagnostics.warn({
      code: DiagnosticCodes.BuildCacheInvalid,
      message: `Failed to write build cache: ${errorMessage(error)}`,
    });
  }
};
