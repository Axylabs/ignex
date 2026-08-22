/**
 * Stable event-id hashing. Event ids were previously the insertion order of
 * the `events` registry — a schema reorder silently changed every id and
 * broke every connected client. Switching to FNV-1a 32-bit over the event
 * name makes ids stable across reordering / field additions, which is what a
 * versioned wire format needs.
 *
 * Collisions are astronomically unlikely for a handful of names and are
 * additionally rejected at generate time (`scripts/generate.ts`).
 */

/** FNV-1a 32-bit (unsigned) — the standard 32-bit variant, seed 2166136261. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable event id for an event name (FNV-1a 32-bit of the name). */
export function eventId(name: string): number {
  return fnv1a32(name);
}
