/**
 * @fileoverview Pure router utilities — path → regex, and Bun handler-arg
 * extraction.
 *
 * These are dependency-free helpers shared by the interpreted router
 * (`http/router.ts`): `pathToRegex` converts Bun-style paths (`:id`, `*`) to a
 * JS regex for the fallback dispatch, and `extractParams`/`extractServer`
 * resolve Bun's handler arguments (`(req, params?, server?)`) via duck-typing,
 * mirroring the compiled `__extractParams`/`__extractServer`.
 *
 * `pathToRegex` is a pure function; `compiledPathFor` wraps it with a bounded
 * memo cache — the interpreted router used to recompile the regex on EVERY
 * request, while route paths are a finite registration-time set, so caching
 * is a pure win on the hot path.
 */

import type { IgnexServer } from "./context";

/** A compiled path pattern: the anchored regex plus the captured param names. */
export interface CompiledPath {
  readonly re: RegExp;
  readonly keys: readonly string[];
}

/** Escape a literal path segment for inclusion in a RegExp source. */
const escapeSegment = (seg: string): string => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Convert a Bun-style route path to an anchored JS regex plus the captured
 * parameter names.
 *
 * - `:name` → `([^/]+)` (single segment, captured as `name`)
 * - `*` → `(.*)` (catch-all, captured as `"*"`)
 * - any other segment is escaped literally
 *
 * @param path - Bun route path, e.g. `/api/users/:id` or `/files/*`.
 * @returns The anchored regex and the ordered param names.
 */
export const pathToRegex = (path: string): CompiledPath => {
  const keys: string[] = [];
  const source = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      if (seg === "*") {
        keys.push("*");
        return "(.*)";
      }
      return escapeSegment(seg);
    })
    .join("/");
  return { re: new RegExp(`^${source}$`), keys };
};

/** Bounded memo cache for compiled paths (route paths are a finite set). */
const compiledPathCache = new Map<string, CompiledPath>();
const MAX_CACHED_PATHS = 512;

/**
 * Memoized {@link pathToRegex}. Route paths are registered once per app, so
 * the compiled result is stable — recompiling per request was pure waste.
 * Bounded to `MAX_CACHED_PATHS` entries (FIFO eviction) so an app that
 * generates paths at runtime can never grow the cache without bound.
 */
export const compiledPathFor = (path: string): CompiledPath => {
  const hit = compiledPathCache.get(path);
  if (hit !== undefined) return hit;
  const compiled = pathToRegex(path);
  if (compiledPathCache.size >= MAX_CACHED_PATHS) {
    const oldest = compiledPathCache.keys().next().value;
    if (oldest !== undefined) compiledPathCache.delete(oldest);
  }
  compiledPathCache.set(path, compiled);
  return compiled;
};

/** True when `x` looks like a Bun server object (duck-typed). */
const isServerLike = (x: unknown): boolean =>
  !!x && typeof x === "object" && ("requestIP" in x || "fetch" in x || "stop" in x);

/**
 * Resolve the route params from Bun's handler arguments.
 *
 * Bun may pass params as `req.params`, the second argument (dynamic routes),
 * or the third; a server object is never params. Mirrors the compiled
 * `__extractParams`.
 *
 * @returns The params object, or `undefined` when none are present.
 */
export const extractParams = (
  req: Request,
  a?: unknown,
  b?: unknown,
): Record<string, string> | undefined => {
  if (req && typeof req === "object" && "params" in req && (req as { params?: unknown }).params) {
    return (req as { params: Record<string, string> }).params;
  }
  if (a && typeof a === "object" && !isServerLike(a)) return a as Record<string, string>;
  if (b && typeof b === "object" && !isServerLike(b)) return b as Record<string, string>;
  return undefined;
};

/**
 * Resolve the Bun server from the handler arguments (duck-typed). Mirrors the
 * compiled `__extractServer`.
 *
 * @returns The server object, or `undefined` when none is present.
 */
export const extractServer = (a?: unknown, b?: unknown): IgnexServer | undefined => {
  if (isServerLike(a)) return a as IgnexServer;
  if (isServerLike(b)) return b as IgnexServer;
  return undefined;
};
