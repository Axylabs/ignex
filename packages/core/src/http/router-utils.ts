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
 * Kept as pure functions (no closure/global state) so they are trivially
 * unit-testable and reusable by any JS dispatcher.
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
