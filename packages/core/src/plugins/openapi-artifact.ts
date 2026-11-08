/**
 * @fileoverview OpenAPI artifact discovery for compiled and standalone apps.
 */

import type { OpenAPIDocument } from "../openapi";

/** Parse the build-embedded document, tolerating malformed global state. */
export const embeddedArtifact = (): OpenAPIDocument | undefined => {
  const embedded = (globalThis as { __IGNEX_OPENAPI_JSON?: string }).__IGNEX_OPENAPI_JSON;
  if (!embedded) return undefined;
  try {
    return JSON.parse(embedded) as OpenAPIDocument;
  } catch {
    return undefined;
  }
};

/** Find the newest readable artifact; explicit candidates win equal mtimes. */
export const newestArtifact = async (
  candidates: readonly string[],
): Promise<{ path: string; mtimeMs: number } | undefined> => {
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const candidate of candidates) {
    try {
      const file = Bun.file(candidate);
      if (!(await file.exists())) continue;
      const mtimeMs = file.lastModified;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs };
    } catch {
      // Unreadable candidate — try the next.
    }
  }
  return newest;
};
