/**
 * @fileoverview Capability probe: does the loaded castrum's form decoder match
 * JS `decodeURIComponent` semantics?
 *
 * `queryPairs` is measurably FASTER natively past ~512B (1.17-1.22x, see
 * `SIZE_GATES.queryPairs`), but selecting it is only safe when the addon's
 * decoder answers like the pure-TS fallback. castrum before 0.9.5 did not:
 *
 * - a malformed escape (truncated / non-hex, e.g. `%2`, `%ZZ`, a trailing `%`)
 *   made the packed writer FAIL, so the C-ABI returned 0 and the JS wrapper
 *   threw `query: parse failed` — a 500 for attacker-supplied input;
 * - an escape decoding to invalid UTF-8 (`%C3`, `%FF`, a surrogate half) was
 *   emitted lossily instead of returning the segment raw as JS does.
 *
 * A differential fuzz against the JS fallback threw on 17,496 of 20,011 inputs.
 * Rather than pin the op forever (or trust that everyone upgrades), the op is
 * bound to native only when THIS addon build passes the probe below — the same
 * probe-gated pattern as the `buffer`/`buffer_length` ABI pair in `ffi.ts`.
 *
 * The probe runs once per process (memoized) and costs a handful of tiny FFI
 * calls.
 */

import { getFfi } from "./ffi";
import { readPairsPacked } from "./packed";
import { encoder } from "./util";

interface ProbeCase {
  /** Query string handed to the packed parser. */
  readonly input: string;
  /** Exactly what the JS fallback (`decodeURIComponent` semantics) returns. */
  readonly expected: ReadonlyArray<readonly [string, string]>;
}

/**
 * Probe cases. Kept as literal expectations (not calls into the fallback) so
 * this module has NO dependency on `http/query` — that would be a cycle, and a
 * probe that asked the implementation under test what the answer should be
 * would prove nothing.
 */
const PROBE_CASES: readonly ProbeCase[] = [
  // Malformed / truncated escapes → JS throws URIError, the fallback returns
  // the segment RAW. Old castrum: threw `query: parse failed`.
  { input: "a=%C3", expected: [["a", "%C3"]] },
  { input: "a=%2", expected: [["a", "%2"]] },
  { input: "a=%", expected: [["a", "%"]] },
  { input: "100%", expected: [["100%", ""]] },
  { input: "x=1+2%ZZ", expected: [["x", "1+2%ZZ"]] },
  // Valid escape that decodes to invalid UTF-8 → JS throws → raw. Old castrum
  // emitted the lossy byte (read back as U+FFFD).
  { input: "a=%FF", expected: [["a", "%FF"]] },
  // Surrogate half (invalid UTF-8) → raw.
  { input: "a=%ED%A0%80", expected: [["a", "%ED%A0%80"]] },
  // Valid escapes must STILL decode — a probe that only tested the fallback
  // would pass on a decoder that never decodes anything.
  {
    input: "a=%20b&c=hello+world",
    expected: [
      ["a", " b"],
      ["c", "hello world"],
    ],
  },
  { input: "u=%E2%9C%93", expected: [["u", "\u2713"]] },
];

let cached: boolean | undefined;

/**
 * True when the loaded addon's form decoder is JS-compatible, i.e. when
 * `queryPairs` (and the packed form parser) may run natively. Probe-gated and
 * memoized; never throws.
 */
export const nativeQueryDecodeMatchesJs = (): boolean => {
  if (cached !== undefined) return cached;
  const ffi = getFfi();
  // No C-ABI transport (NAPI/Node/`IGNEX_NATIVE=off`): the capability is moot
  // and NOT cached — the ffi bind is lazy, so a later call must be free to
  // observe it coming up.
  if (ffi === null) return false;
  try {
    cached = PROBE_CASES.every(({ input, expected }) => {
      const got = readPairsPacked(ffi.queryParsePacked(encoder.encode(input)));
      return JSON.stringify(got) === JSON.stringify(expected);
    });
  } catch {
    // A throwing decoder IS the defect this probe exists to detect.
    cached = false;
  }
  return cached;
};
