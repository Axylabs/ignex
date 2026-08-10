/**
 * Build-time route schema loader.
 *
 * Bun 1.4 edition:
 * - dynamic import remains native Bun TS import
 * - structuredClone for schema cloning
 * - cache is keyed by file content hash and never caches failures, so a
 *   transient import error does not poison the rest of the build.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DiagnosticCodes, type DiagnosticCollector, errorMessage } from "../diagnostics";
import { hashString } from "../utils/hash";

const moduleCache = new Map<string, unknown>();

const contentHash = (absPath: string): string => {
  try {
    return hashString(readFileSync(absPath, "utf-8"));
  } catch {
    return "unreadable";
  }
};

export const loadRouteModule = async (
  absPath: string,
  diagnostics?: DiagnosticCollector,
  handlerExportName?: string,
): Promise<any | undefined> => {
  const key = `${absPath}#${contentHash(absPath)}#${handlerExportName ?? "default"}`;

  if (moduleCache.has(key)) {
    return moduleCache.get(key);
  }

  try {
    const url = pathToFileURL(absPath).href;
    const mod: any = await import(url);

    // Named-export routes (`export const httpGet = get(...)`) attach their
    // schema to the exported handler via `attachSchema`; default-export routes
    // attach it to `mod.default`.
    const handler = handlerExportName ? mod?.[handlerExportName] : mod?.default;

    const inlineSchema =
      handler != null && typeof handler === "object" && "schema" in handler
        ? handler.schema
        : typeof handler === "function" && "schema" in handler
          ? handler.schema
          : undefined;

    const schema = mod?.schema ?? inlineSchema;
    const normalized = schema === undefined ? mod : { ...mod, schema };

    moduleCache.set(key, normalized);

    return normalized;
  } catch (error) {
    // Do NOT cache failures: a transient error must not stick for the process.
    diagnostics?.warn({
      code: DiagnosticCodes.ModuleLoadFailed,
      message: `Failed to load module for precompilation: ${errorMessage(error)}`,
      file: absPath,
    });

    return undefined;
  }
};

export const isStandardSchema = (value: unknown): boolean => {
  return typeof value === "object" && value !== null && "~standard" in value;
};

export const cloneSchema = (value: unknown): any => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
};
