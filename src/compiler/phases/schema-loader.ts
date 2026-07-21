/**
 * Build-time route schema loader.
 *
 * Bun 1.4 edition:
 * - dynamic import remains native Bun TS import
 * - structuredClone for schema cloning
 */

import { pathToFileURL } from "node:url";

const moduleCache = new Map<string, unknown>();

export const loadRouteModule = async (
  absPath: string
): Promise<any | undefined> => {
  if (moduleCache.has(absPath)) {
    return moduleCache.get(absPath);
  }

  try {
    const url = pathToFileURL(absPath).href;
    const mod: any = await import(url);

    const handler = mod?.default;

    const inlineSchema =
      handler != null && typeof handler === "object" && "schema" in handler
        ? handler.schema
        : typeof handler === "function" && "schema" in handler
          ? handler.schema
          : undefined;

    const schema = mod?.schema ?? inlineSchema;
    const normalized = schema === undefined ? mod : { ...mod, schema };

    moduleCache.set(absPath, normalized);

    return normalized;
  } catch {
    moduleCache.set(absPath, undefined);
    return undefined;
  }
};

export const isStandardSchema = (value: unknown): boolean => {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value
  );
};

export const cloneSchema = (value: unknown): any => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
};
