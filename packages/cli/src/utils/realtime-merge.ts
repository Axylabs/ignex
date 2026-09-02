/**
 * @fileoverview Additive merge of an event into a `src/realtime.ts` wire
 * contract.
 *
 * `ignex event bus` must be safe to run MORE THAN ONCE: the contract file is
 * the single source of truth and may already declare events (a previous bus,
 * or hand-added ones). Re-running the wizard for another event must ADD a
 * registry entry — never overwrite the file (which would drop existing
 * events) and never leave a consumer/emit-route referencing an unregistered
 * event (which is a TS2345 against the typed facade).
 *
 * The merge is a conservative TEXT edit: it locates the `events: { … }`
 * object inside the `realtime` declaration and inserts a new
 * `"<name>": Type.Object({ id, at })` entry before its closing brace, adding
 * a trailing comma to the previous entry only when one is missing. It works
 * on the scaffolded shape and on hand-edited contracts that keep the same
 * object structure. When the structure is not recognizable it refuses to
 * touch the file (returns `added: false`) rather than corrupt user code.
 */

/** One-line scaffold entry inserted into the events registry. */
export const eventEntryLine = (eventName: string): string =>
  `    "${eventName}": Type.Object({ id: Type.String(), at: Type.Integer() }),`;

export interface RealtimeMergeResult {
  /** The (possibly modified) source text. */
  source: string;
  /** Whether an entry was added (false when already present or unmergeable). */
  added: boolean;
  /** Why nothing was added, when applicable. */
  reason?: "present" | "unparseable";
}

/** Line index of the `events:` key, or -1 when the shape isn't recognized. */
const findEventsKeyLine = (lines: string[]): number => {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^\s*events\s*:/.test(line)) return i;
  }
  return -1;
};

/**
 * Line index of the events object's matching `}` (may be the key line itself
 * for an inline `events: {}`), or -1 when the braces never balance.
 */
const findClosingBraceLine = (lines: string[], start: number): number => {
  let depth = 0;
  let inString = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
};

/** Replace an inline `events: {}` with a block containing `entry`. */
const expandEmptyInline = (lines: string[], idx: number, entry: string): boolean => {
  const line = lines[idx];
  if (line === undefined) return false;
  const open = line.indexOf("{");
  const close = line.indexOf("}", open + 1);
  if (open === -1 || close === -1) return false;
  const indent = line.slice(0, open); // e.g. `  events: `
  const tail = line.slice(close + 1); // e.g. `,`
  lines[idx] = `${indent}{\n${entry}\n  }${tail}`;
  return true;
};

/** Append `,` to the line at `idx` when it holds a value and lacks one. */
const ensureTrailingComma = (lines: string[], idx: number): void => {
  const line = lines[idx];
  if (line === undefined) return;
  const trimmed = line.trimEnd();
  if (trimmed === "" || trimmed.endsWith(",") || trimmed.endsWith("{")) return;
  lines[idx] = `${trimmed},`;
};

/**
 * Add `eventName` to the `events` object of a realtime contract source.
 *
 * @param source - Raw text of `src/realtime.ts`.
 * @param eventName - Contract key to add (e.g. `recive-fe.created`).
 */
export const mergeEventIntoRealtimeSource = (
  source: string,
  eventName: string,
): RealtimeMergeResult => {
  // Already declared (as a quoted key anywhere) — idempotent no-op.
  if (source.includes(`"${eventName}"`)) {
    return { source, added: false, reason: "present" };
  }

  const lines = source.split("\n");
  const keyIdx = findEventsKeyLine(lines);
  if (keyIdx === -1) return { source, added: false, reason: "unparseable" };

  const closeIdx = findClosingBraceLine(lines, keyIdx);
  if (closeIdx === -1) return { source, added: false, reason: "unparseable" };

  const entry = eventEntryLine(eventName);
  if (closeIdx === keyIdx) {
    if (!expandEmptyInline(lines, keyIdx, entry)) {
      return { source, added: false, reason: "unparseable" };
    }
  } else {
    // Multi-line object: insert before its closing brace.
    ensureTrailingComma(lines, closeIdx - 1);
    lines.splice(closeIdx, 0, entry);
  }

  return { source: lines.join("\n"), added: true };
};
