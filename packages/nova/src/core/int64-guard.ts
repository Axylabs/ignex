/**
 * Lossless-int64 guard. Plain `number` int64 fields silently lose precision
 * above ±2^53-1 (the value is coerced through a double). The real fix is
 * `Type.Integer({ bigint: true })` (exact `bigint` fields); this module is the
 * safety net that catches out-of-range NUMBERS at encode time.
 *
 * The generated direct encoders call `checkInt64` for every non-bigint int64
 * field. Mode is configurable (server option `int64Guard`); when `"off"` (the
 * default) the check is a cheap no-op so the zero-alloc hot path is untouched.
 */
export type Int64GuardMode = "off" | "throw" | "warn";

let mode: Int64GuardMode = "off";
const warned = new Set<string>();

export function setInt64GuardMode(m: Int64GuardMode): void {
  mode = m;
}

export function getInt64GuardMode(): Int64GuardMode {
  return mode;
}

/**
 * Assert `v` (a plain-number int64 field) is a safe integer. No-op in "off"
 * mode. `label` is `"<event>.<field>"` for diagnostics.
 */
export function checkInt64(label: string, v: unknown): void {
  if (mode === "off") return;
  if (typeof v === "bigint") return; // already exact
  const n = v as number;
  if (Number.isSafeInteger(n)) return;
  if (mode === "throw") {
    throw new RangeError(
      `ignex: int64 field "${label}" value ${n} is outside the safe-integer range (±2^53-1) and would lose precision — annotate it with Type.Integer({ bigint: true })`,
    );
  }
  if (!warned.has(label)) {
    warned.add(label);
    console.warn(
      `ignex: int64 field "${label}" value ${n} is outside the safe-integer range (±2^53-1) and will lose precision — annotate it with Type.Integer({ bigint: true })`,
    );
  }
}
