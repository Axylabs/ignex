/**
 * @fileoverview Shared type guards.
 *
 * `isRecord` is the JSON-style "non-null, non-array object" predicate. It used
 * to exist as a private copy in six files across `@ignex/cli`,
 * `@ignex/compiler` and `@ignex/core`; this is now the single definition.
 *
 * Note: the fault taxonomy (`platform/fault-throw.ts`) uses a deliberately
 * *different* predicate (`Record<PropertyKey, unknown>`, arrays included) when
 * walking an arbitrary thrown value — do not swap that one for this.
 */

/** True when `value` is a non-null, non-array object — a JSON-style record. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
