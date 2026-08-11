/**
 * @fileoverview Media-type parsing and wildcard matching.
 */

import type { MediaTypeResult } from "./types";

export const parseMediaType = (input: string): MediaTypeResult =>
  // Selection: js (native marked @deprecated / slower) — see selection.ts.
  parseMediaTypeFallback(input);

export const parseMediaTypeFallback = (input: string): MediaTypeResult => {
  const idx = input.indexOf(";");
  const mediaType = (idx < 0 ? input : input.slice(0, idx)).trim().toLowerCase();
  const params: Record<string, string> = {};
  if (idx >= 0) {
    for (const seg of input.slice(idx + 1).split(";")) {
      const eq = seg.indexOf("=");
      if (eq < 0) continue;
      const k = seg.slice(0, eq).trim().toLowerCase();
      const v = seg
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
      params[k] = v;
    }
  }
  const result: MediaTypeResult = { mediaType, params };
  if (params.charset) result.charset = params.charset;
  if (params.boundary) result.boundary = params.boundary;
  return result;
};

/** Wildcard media-type match: `"*"` (any), `"type/*"`, or exact `"type/subtype"`. */
export const mediaTypeMatches = (actual: string, expected: string): boolean => {
  const a = actual.toLowerCase().trim().split(";")[0] ?? "";
  const e = expected.toLowerCase().trim();
  if (e === "*/*") return true;
  if (e.endsWith("/*")) return a.startsWith(e.slice(0, -1));
  return a === e;
};
