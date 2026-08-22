/**
 * Keyset (cursor) pagination helpers — pure, DB-agnostic.
 *
 * Unlike offset pagination, keyset pagination filters on the *last seen* row's
 * sort values, so it stays O(log n) regardless of page depth (no deep `$skip`)
 * and is stable under concurrent inserts. It cannot report a total count —
 * use `paginateFlexible` ($facet) when you need totals.
 *
 * Requirement: every sort key (and the `_id` tiebreaker) should exist on every
 * document for deterministic ordering, since the boundary comparison relies on
 * them.
 */

import type { Document } from "mongodb";
import { ObjectId } from "mongodb";
import { BadRequest } from "../errors/index.ts";

/** Serializable, tagged representation of a cursor boundary value. */
type TaggedValue = {
  t: "oid" | "date" | "string" | "number" | "boolean" | "null";
  v?: string | number | boolean;
};

export interface KeysetCursor {
  /** The sort spec this cursor belongs to (used to reject mismatched cursors). */
  sort: Record<string, 1 | -1>;
  /** Boundary field values, in sort-key order. */
  values: unknown[];
}

const tag = (value: unknown): TaggedValue => {
  if (value instanceof ObjectId) return { t: "oid", v: value.toHexString() };
  if (value instanceof Date) return { t: "date", v: value.toISOString() };
  if (typeof value === "string") return { t: "string", v: value };
  if (typeof value === "number") return { t: "number", v: value };
  if (typeof value === "boolean") return { t: "boolean", v: value };
  if (value === null || value === undefined) return { t: "null" };
  // A drifted sort-field value (object/array/…) cannot be encoded losslessly
  // into a cursor — a `String(value)` fallback would silently corrupt
  // pagination (the decoded boundary could never compare against the real
  // field type). Fail loudly instead of serving a wrong page.
  throw new BadRequest(
    `paginateCursor: unsupported sort value type "${typeof value}" — key values must be ObjectId, Date, string, number, boolean, or null`,
  );
};

const untag = (tagged: TaggedValue): unknown => {
  switch (tagged.t) {
    case "oid":
      return new ObjectId(tagged.v as string);
    case "date":
      return new Date(tagged.v as string);
    case "string":
      return tagged.v as string;
    case "number":
      return tagged.v as number;
    case "boolean":
      return tagged.v as boolean;
    case "null":
      return null;
  }
};

/** Base64url-encode a cursor. The payload is opaque to callers. */
export const encodeCursor = (cursor: KeysetCursor): string =>
  Buffer.from(
    JSON.stringify({
      sort: cursor.sort,
      values: cursor.values.map(tag),
    }),
    "utf8",
  ).toString("base64url");

/** Decode + validate an opaque cursor. Throws on malformed input. */
export const decodeCursor = (cursor: string): KeysetCursor => {
  let parsed: { sort?: Record<string, 1 | -1>; values?: TaggedValue[] };
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new BadRequest("paginateCursor: invalid cursor");
  }
  if (!parsed || typeof parsed !== "object" || !parsed.sort || !Array.isArray(parsed.values)) {
    throw new BadRequest("paginateCursor: invalid cursor payload");
  }
  return { sort: parsed.sort, values: parsed.values.map(untag) };
};

/**
 * Build the keyset filter for the next page.
 *
 * Sort keys `[k1(d1), k2(d2), ...]` with boundary values `[v1, v2, ...]` produce
 * the standard disjunction of prefix-equalities plus a strict comparison on the
 * next key:
 *
 *   k1 ≻ v1  OR  (k1 = v1 AND k2 ≻ v2)  OR  ...  OR  (k1 = v1 AND ... AND kn ≻ vn)
 *
 * where `≻` is `>` for ascending keys and `<` for descending keys when
 * `direction` is `'after'` (inverted for `'before'`). `_id` is the natural
 * unique tiebreaker.
 */
export const buildKeysetFilter = (
  sort: Record<string, 1 | -1>,
  values: unknown[],
  direction: "after" | "before",
): Document => {
  const keys = Object.entries(sort);
  const ors: Document[] = [];
  for (let i = 0; i < keys.length; i++) {
    const cond: Document = {};
    for (let j = 0; j < i; j++) {
      const [f] = keys[j]!;
      cond[f] = values[j];
    }
    const [field, dir] = keys[i]!;
    const value = values[i];
    const cmp = direction === "after" ? (dir === 1 ? "$gt" : "$lt") : dir === 1 ? "$lt" : "$gt";
    cond[field] = { [cmp]: value };
    ors.push(cond);
  }
  return { $or: ors };
};
