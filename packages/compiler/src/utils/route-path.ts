/**
 * @fileoverview Route-path segment interpretation — the single source of
 * truth for how the file-based routing convention's `:param` and `*wildcard`
 * segments are matched. Used by both analysis (conflict detection) and
 * codegen (route-table matchers) so the two can never disagree about what a
 * segment means.
 */

/** Escape a literal segment for use inside a RegExp source. */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Extract `*name` wildcard identifiers from a route path. */
export const wildcardNames = (path: string): string[] =>
  Array.from(path.matchAll(/\*([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);

/** Normalize a dynamic segment to a stable marker (`:param` / `*`). */
export const normalizePatternSegment = (segment: string): string => {
  if (segment.startsWith(":")) return ":param";
  if (segment.startsWith("*")) return "*";
  return segment;
};

/** Normalize a full path for pattern comparison (e.g. conflict detection). */
export const normalizePathPattern = (path: string): string =>
  path.split("/").map(normalizePatternSegment).join("/");

/** RegExp source fragment matching a single path segment. */
export const segmentRegexSource = (segment: string): string => {
  if (segment.startsWith(":")) return "[^/]+";
  if (segment.startsWith("*")) return ".*";
  return escapeRegExp(segment);
};

/** Anchored RegExp source matching a route path with dynamic segments. */
export const pathRegexSource = (path: string): string =>
  `^${path.split("/").map(segmentRegexSource).join("/")}$`;
