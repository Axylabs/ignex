/**
 * Heterogeneous task-group FFI — MANY different Rust actions in ONE C-ABI call.
 *
 * `runTasks([...])` packs an arbitrary list of DIFFERENT operations into one
 * `castrum_execute_tasks` call (see castrum `rust/ffi.rs`), executes them all
 * in a single crossing, and returns typed results in task order. This is the
 * "group multiple actions into one FFI call" surface: a request hot path
 * (parse query + parse cookies + validate + verifyCookie + hmacVerify …) pays
 * ONE crossing instead of N.
 *
 * Group when you have >= 2-3 tasks (the C-ABI crossing is ~100ns, so grouping
 * is where the amortization pays). Falls back to per-task scalar calls when
 * the C-ABI surface is unavailable (parity guaranteed — same bytes either way).
 */

import {
  csrfToken,
  csrfVerify,
  hmacSha256,
  hmacSha256Verify,
  randomToken,
  signCookie,
  verifyCookie,
} from "./crypto";
import { getFfi } from "./ffi";
import { ffiBuf, ffiU32, ffiU64 } from "./ffi-read";
import { crc32, fnv1a64 } from "./hash";
import { cookiePairs, etag, formPairs, queryPairs } from "./http";
import { jsonValid } from "./json";
import { readPairsPacked } from "./packed";
import { withScratch } from "./scratch";
import { decoder, encoder } from "./util";
import { validateEmail, validateIpv4, validateIpv6, validateUuid } from "./validation";

/** A single heterogeneous task executed inside ONE FFI call. */
export type Task =
  | { op: "fnv1a64"; input: Uint8Array }
  | { op: "crc32"; input: Uint8Array }
  | { op: "jsonValid"; input: Uint8Array }
  | { op: "validateEmail"; input: Uint8Array }
  | { op: "validateUuid"; input: Uint8Array }
  | { op: "validateIpv4"; input: Uint8Array }
  | { op: "validateIpv6"; input: Uint8Array }
  | { op: "hmacSha256"; key: Uint8Array; data: Uint8Array }
  | { op: "hmacSha256Verify"; key: Uint8Array; data: Uint8Array; sig: Uint8Array }
  | { op: "signCookie"; value: Uint8Array; secret: Uint8Array }
  | { op: "verifyCookie"; signed: Uint8Array; secret: Uint8Array }
  | { op: "csrfToken"; secret: Uint8Array }
  | { op: "csrfVerify"; token: Uint8Array; secret: Uint8Array }
  | { op: "etag"; data: Uint8Array; weak?: boolean }
  | { op: "randomToken"; byteLen: number }
  | { op: "queryParse"; input: Uint8Array }
  | { op: "cookieParse"; input: Uint8Array }
  | { op: "formParse"; input: Uint8Array };

/** Typed result for a task (position-aligned with the input task list). */
export type TaskResult =
  | { op: "fnv1a64"; value: bigint }
  | { op: "crc32"; value: number }
  | { op: "jsonValid"; value: boolean }
  | { op: "validateEmail"; value: boolean }
  | { op: "validateUuid"; value: boolean }
  | { op: "validateIpv4"; value: boolean }
  | { op: "validateIpv6"; value: boolean }
  | { op: "hmacSha256"; value: Uint8Array }
  | { op: "hmacSha256Verify"; value: boolean }
  | { op: "signCookie"; value: Uint8Array }
  | { op: "verifyCookie"; value: Uint8Array | null }
  | { op: "csrfToken"; value: Uint8Array }
  | { op: "csrfVerify"; value: boolean }
  | { op: "etag"; value: Uint8Array }
  | { op: "randomToken"; value: Uint8Array }
  | { op: "queryParse"; value: Array<[string, string]> }
  | { op: "cookieParse"; value: Array<[string, string]> }
  | { op: "formParse"; value: Array<[string, string]> };

// Op tags — MUST match `OP_*` constants in castrum `rust/ffi.rs`.
const TAG: Record<Task["op"], number> = {
  fnv1a64: 0,
  crc32: 1,
  jsonValid: 2,
  validateEmail: 3,
  validateUuid: 4,
  validateIpv4: 5,
  validateIpv6: 6,
  hmacSha256: 7,
  hmacSha256Verify: 8,
  signCookie: 9,
  verifyCookie: 10,
  csrfToken: 11,
  csrfVerify: 12,
  etag: 13,
  randomToken: 14,
  queryParse: 15,
  cookieParse: 16,
  formParse: 17,
};

const dv = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Payload byte-length for a task (matches the Rust `take_len_field` layouts). */
const payloadLen = (task: Task): number => {
  switch (task.op) {
    case "fnv1a64":
    case "crc32":
    case "jsonValid":
    case "validateEmail":
    case "validateUuid":
    case "validateIpv4":
    case "validateIpv6":
    case "queryParse":
    case "cookieParse":
    case "formParse":
      return task.input.length;
    case "hmacSha256":
      return 4 + task.key.length + task.data.length;
    case "hmacSha256Verify":
      return 4 + task.key.length + 4 + task.data.length + task.sig.length;
    case "signCookie":
      return 4 + task.value.length + task.secret.length;
    case "verifyCookie":
      return 4 + task.signed.length + task.secret.length;
    case "csrfToken":
      return task.secret.length;
    case "csrfVerify":
      return 4 + task.token.length + task.secret.length;
    case "etag":
      return 4 + task.data.length + 1;
    case "randomToken":
      return 4;
  }
};

/** Write a task's payload bytes at `pos`; returns the next position. */
const writePayload = (out: Uint8Array, pos: number, task: Task): number => {
  const w = (n: number, p: number): number => {
    dv(out).setUint32(p, n, true);
    return p + 4;
  };
  const wBytes = (bytes: Uint8Array, p: number): number => {
    out.set(bytes, p);
    return p + bytes.length;
  };
  let p = pos;
  switch (task.op) {
    case "fnv1a64":
    case "crc32":
    case "jsonValid":
    case "validateEmail":
    case "validateUuid":
    case "validateIpv4":
    case "validateIpv6":
    case "queryParse":
    case "cookieParse":
    case "formParse":
      return wBytes(task.input, p);
    case "hmacSha256":
      p = w(task.key.length, p);
      p = wBytes(task.key, p);
      return wBytes(task.data, p);
    case "hmacSha256Verify":
      p = w(task.key.length, p);
      p = wBytes(task.key, p);
      p = w(task.data.length, p);
      p = wBytes(task.data, p);
      return wBytes(task.sig, p);
    case "signCookie":
      p = w(task.value.length, p);
      p = wBytes(task.value, p);
      return wBytes(task.secret, p);
    case "verifyCookie":
      p = w(task.signed.length, p);
      p = wBytes(task.signed, p);
      return wBytes(task.secret, p);
    case "csrfToken":
      return wBytes(task.secret, p);
    case "csrfVerify":
      p = w(task.token.length, p);
      p = wBytes(task.token, p);
      return wBytes(task.secret, p);
    case "etag":
      p = w(task.data.length, p);
      p = wBytes(task.data, p);
      out[p] = task.weak ? 1 : 0;
      return p + 1;
    case "randomToken":
      return w(task.byteLen, p);
  }
};

/** Packed byte-length of a task list (size a pooled buffer exactly). */
export const packTasksLength = (tasks: readonly Task[]): number => {
  let total = 4;
  for (const t of tasks) total += 1 + 4 + payloadLen(t);
  return total;
};

/** Write the `[u32 count]{ [u8 op][u32 len][payload] }` wire into `out`. */
export const packTasksInto = (out: Uint8Array, tasks: readonly Task[]): void => {
  dv(out).setUint32(0, tasks.length, true);
  let pos = 4;
  for (const t of tasks) {
    out[pos] = TAG[t.op];
    pos += 1;
    dv(out).setUint32(pos, payloadLen(t), true);
    pos += 4;
    pos = writePayload(out, pos, t);
  }
};

/** Pack the full task list into a fresh buffer (prefer the pooled `runTasks` path). */
export const packTasks = (tasks: readonly Task[]): Uint8Array => {
  const out = new Uint8Array(packTasksLength(tasks));
  packTasksInto(out, tasks);
  return out;
};

const readU64 = (b: Uint8Array): bigint => ffiU64(ffiBuf(b), 0);
const readU32 = (b: Uint8Array): number => ffiU32(ffiBuf(b), 0) >>> 0;

/** Upper bound on one task's result bytes (exact for fixed-size ops). */
const resultBound = (task: Task): number => {
  switch (task.op) {
    case "fnv1a64":
      return 8;
    case "crc32":
      return 4;
    case "jsonValid":
    case "validateEmail":
    case "validateUuid":
    case "validateIpv4":
    case "validateIpv6":
    case "hmacSha256Verify":
    case "csrfVerify":
      return 1;
    case "hmacSha256":
      return 64;
    case "signCookie":
      return task.value.length + 65;
    case "verifyCookie":
      return task.signed.length;
    case "csrfToken":
      return 129;
    case "etag":
      return 12;
    case "randomToken":
      return task.byteLen * 2;
    case "queryParse":
    case "cookieParse":
    case "formParse":
      // Packed pairs bound: 4 + Σ(8 + name + value) ≤ 9·len + 4.
      return task.input.length * 9 + 4;
  }
};

/** Upper bound on the full output wire (`[u32 count]{[u32 len][bytes]}`). */
const outputBound = (tasks: readonly Task[]): number =>
  4 + tasks.reduce((sum, t) => sum + 4 + resultBound(t), 0);

/** Interpret one task's raw result bytes into its typed shape. */
const interpret = (task: Task, result: Uint8Array): TaskResult => {
  switch (task.op) {
    case "fnv1a64":
      return { op: "fnv1a64", value: readU64(result) };
    case "crc32":
      return { op: "crc32", value: readU32(result) };
    case "jsonValid":
      return { op: "jsonValid", value: result[0] === 1 };
    case "validateEmail":
      return { op: "validateEmail", value: result[0] === 1 };
    case "validateUuid":
      return { op: "validateUuid", value: result[0] === 1 };
    case "validateIpv4":
      return { op: "validateIpv4", value: result[0] === 1 };
    case "validateIpv6":
      return { op: "validateIpv6", value: result[0] === 1 };
    case "hmacSha256":
      return { op: "hmacSha256", value: result };
    case "hmacSha256Verify":
      return { op: "hmacSha256Verify", value: result[0] === 1 };
    case "signCookie":
      return { op: "signCookie", value: result };
    case "verifyCookie":
      return { op: "verifyCookie", value: result.length === 0 ? null : result };
    case "csrfToken":
      return { op: "csrfToken", value: result };
    case "csrfVerify":
      return { op: "csrfVerify", value: result[0] === 1 };
    case "etag":
      return { op: "etag", value: result };
    case "randomToken":
      return { op: "randomToken", value: result };
    case "queryParse":
      return { op: "queryParse", value: readPairsPacked(result) };
    case "cookieParse":
      return { op: "cookieParse", value: readPairsPacked(result) };
    case "formParse":
      return { op: "formParse", value: readPairsPacked(result) };
  }
};

/** Fallback: run each task via the scalar wrappers (no C-ABI transport). */
const runTaskScalar = (task: Task): TaskResult => {
  switch (task.op) {
    case "fnv1a64":
      return { op: "fnv1a64", value: fnv1a64(task.input) };
    case "crc32":
      return { op: "crc32", value: crc32(task.input) };
    case "jsonValid":
      return { op: "jsonValid", value: jsonValid(task.input) };
    // Validators take STRINGS (the JS fallback regex needs text, not bytes).
    case "validateEmail":
      return { op: "validateEmail", value: validateEmail(decoder.decode(task.input)) };
    case "validateUuid":
      return { op: "validateUuid", value: validateUuid(decoder.decode(task.input)) };
    case "validateIpv4":
      return { op: "validateIpv4", value: validateIpv4(decoder.decode(task.input)) };
    case "validateIpv6":
      return { op: "validateIpv6", value: validateIpv6(decoder.decode(task.input)) };
    case "hmacSha256":
      return { op: "hmacSha256", value: hmacSha256(task.key, task.data) };
    case "hmacSha256Verify":
      return { op: "hmacSha256Verify", value: hmacSha256Verify(task.key, task.data, task.sig) };
    case "signCookie":
      return {
        op: "signCookie",
        value: encoder.encode(signCookie(decoder.decode(task.value), task.secret)),
      };
    case "verifyCookie": {
      const v = verifyCookie(decoder.decode(task.signed), task.secret);
      return { op: "verifyCookie", value: v === null ? null : encoder.encode(v) };
    }
    case "csrfToken":
      return { op: "csrfToken", value: encoder.encode(csrfToken(task.secret)) };
    case "csrfVerify":
      return { op: "csrfVerify", value: csrfVerify(decoder.decode(task.token), task.secret) };
    // etag/randomToken wrappers return hex STRINGS — encode to match the
    // C-ABI path's Uint8Array result (and the pair parsers return readonly
    // Pairs — spread to the mutable `[string, string][]` the ffi path yields).
    case "etag":
      return { op: "etag", value: encoder.encode(etag(task.data, task.weak)) };
    case "randomToken":
      return { op: "randomToken", value: encoder.encode(randomToken(task.byteLen)) };
    case "queryParse":
      return { op: "queryParse", value: [...queryPairs(task.input)] };
    case "cookieParse":
      return { op: "cookieParse", value: [...cookiePairs(task.input)] };
    case "formParse":
      return { op: "formParse", value: [...formPairs(task.input)] };
  }
};

/**
 * Run a heterogeneous task group in ONE FFI call and return typed results
 * (position-aligned with `tasks`). Falls back to per-task scalar calls when
 * the C-ABI transport is unavailable — byte-compatible either way.
 */
export const runTasks = (tasks: readonly Task[]): TaskResult[] => {
  if (tasks.length === 0) return [];
  const ffi = getFfi();
  if (ffi) {
    // Reuse a pooled scratch buffer for the INPUT wire — the C fn reads it
    // synchronously, so the borrow cannot escape (packed is released before
    // `runTasks` returns). The output buffer stays a fresh `growExact` alloc:
    // it is handed back to the caller (the decode subarrays it), so pooling it
    // would require copying every byte result out — deferred to the per-route
    // native arena (Phase 1), which owns a persistent output buffer instead.
    //
    // Pre-size the output buffer (exact per-op bound) so the C fn runs ONCE —
    // growExact's too-small path would otherwise re-run every task to size it.
    const out = withScratch(packTasksLength(tasks), (packed) => {
      packTasksInto(packed, tasks);
      return ffi.executeTasks(packed, outputBound(tasks));
    });
    const b = ffiBuf(out);
    const count = ffiU32(b, 0);
    let pos = 4;
    const results: TaskResult[] = [];
    for (let i = 0; i < count && i < tasks.length; i++) {
      const len = ffiU32(b, pos);
      pos += 4;
      const bytes = out.subarray(pos, pos + len);
      pos += len;
      results.push(interpret(tasks[i] as Task, bytes));
    }
    return results;
  }
  return tasks.map(runTaskScalar);
};
