/**
 * Heterogeneous task-group API — typed batch of mixed operations.
 *
 * NOTE: castrum REMOVED the `castrum_execute_tasks` C-ABI symbol (the
 * single-crossing task group). `runTasks` now always runs each task through its
 * scalar wrapper (the former fallback) — byte-compatible with the old grouped
 * wire, so the public API is unchanged. If castrum ever re-ships a task-group
 * symbol, the FFI branch can be restored in `runTasks`.
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
import { crc32, fnv1a64 } from "./hash";
import { cookiePairs, etag, formPairs, queryPairs } from "./http";
import { jsonValid } from "./json";
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
  // castrum removed the `castrum_execute_tasks` C-ABI group — run each task via
  // its scalar wrapper (byte-compatible with the old grouped wire).
  return tasks.map(runTaskScalar);
};
