/**
 * Parity tests for the heterogeneous task-group API (`runTasks`) — MANY
 * different Rust actions in ONE FFI call. Each result must equal the scalar
 * wrapper's output. Runs against the C-ABI transport when available, else the
 * per-task scalar fallback — either way the results must match the scalar
 * surface (parity is the contract).
 */
import {
  cookiePairs,
  crc32,
  csrfToken,
  csrfVerify,
  etag,
  fnv1a64,
  formPairs,
  hmacSha256,
  jsonValid,
  queryPairs,
  randomToken,
  runTasks,
  signCookie,
  type TaskResult,
  validateEmail,
  validateIpv4,
  validateIpv6,
  validateUuid,
} from "@ignex/native";
import { describe, expect, it } from "vitest";

const enc = new TextEncoder();
const SECRET = enc.encode("s3cret-key-material-0123456789abcdef");
const HKEY = enc.encode("key-material-0123456789abcdef");
const DATA = enc.encode("hello world");

const bytesEq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

describe("runTasks parity (one FFI call == per-task scalar)", () => {
  it("runs a mixed group and matches every scalar", () => {
    const signed = enc.encode(signCookie("session=abc123", SECRET));
    const token = enc.encode(csrfToken(SECRET));
    const sig = hmacSha256(HKEY, DATA);
    const res = runTasks([
      { op: "fnv1a64", input: DATA },
      { op: "crc32", input: DATA },
      { op: "jsonValid", input: enc.encode('{"a":1}') },
      { op: "validateEmail", input: enc.encode("ada@example.com") },
      { op: "validateUuid", input: enc.encode("123e4567-e89b-12d3-a456-426614174000") },
      { op: "validateIpv4", input: enc.encode("192.168.0.1") },
      { op: "validateIpv6", input: enc.encode("2001:db8::1") },
      { op: "hmacSha256", key: HKEY, data: DATA },
      { op: "hmacSha256Verify", key: HKEY, data: DATA, sig },
      { op: "signCookie", value: enc.encode("session=abc123"), secret: SECRET },
      { op: "verifyCookie", signed, secret: SECRET },
      { op: "csrfToken", secret: SECRET },
      { op: "csrfVerify", token, secret: SECRET },
      { op: "etag", data: DATA },
      { op: "queryParse", input: enc.encode("a=1&b=2") },
      { op: "cookieParse", input: enc.encode("a=1; b=2") },
      { op: "formParse", input: enc.encode("a=1&b=2") },
    ] as const);

    expect(res).toHaveLength(17);
    const [r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15, r16] = res as [
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
      TaskResult,
    ];
    expect(r0.op).toBe("fnv1a64");
    expect(r0.value).toBe(fnv1a64(DATA));
    expect(r1.value).toBe(crc32(DATA));
    expect(r2.value).toBe(jsonValid(enc.encode('{"a":1}')));
    expect(r3.value).toBe(validateEmail("ada@example.com"));
    expect(r4.value).toBe(validateUuid("123e4567-e89b-12d3-a456-426614174000"));
    expect(r5.value).toBe(validateIpv4("192.168.0.1"));
    expect(r6.value).toBe(validateIpv6("2001:db8::1"));
    expect(bytesEq(r7.value as Uint8Array, hmacSha256(HKEY, DATA))).toBe(true);
    // `sig` is a valid signature for (HKEY, DATA) → the group must accept it.
    // (Compared against the KNOWN truth, not the scalar round-trip, which is
    // env-sensitive in the pure-JS fallback across Bun/Node.)
    expect(r8.value).toBe(true);
    expect(bytesEq(r9.value as Uint8Array, enc.encode(signCookie("session=abc123", SECRET)))).toBe(
      true,
    );
    // verifyCookie returns the UNSIGNED value (no `.sig` suffix).
    expect(bytesEq(r10.value as Uint8Array, enc.encode("session=abc123"))).toBe(true);
    expect((r11.value as Uint8Array).length).toBe(129);
    expect(r12.value).toBe(csrfVerify(token, SECRET));
    expect(bytesEq(r13.value as Uint8Array, etag(DATA))).toBe(true);
    expect(r14.value).toEqual(queryPairs("a=1&b=2"));
    expect(r15.value).toEqual(cookiePairs("a=1; b=2"));
    expect(r16.value).toEqual(formPairs("a=1&b=2"));
  });

  it("verifyCookie returns null for a bad signature (empty result frame)", () => {
    const bad = runTasks([
      { op: "verifyCookie", signed: enc.encode("session=abc123.deadbeef"), secret: SECRET },
    ] as const);
    const [bad0] = bad as [TaskResult];
    expect(bad0.value).toBeNull();
  });

  it("hmacSha256Verify rejects a tampered signature", () => {
    const sig = hmacSha256(HKEY, DATA);
    const tampered = new Uint8Array(sig).fill(0);
    const res = runTasks([
      { op: "hmacSha256Verify", key: HKEY, data: DATA, sig: tampered },
    ] as const);
    const [t0] = res as [TaskResult];
    expect(t0.value).toBe(false);
  });

  it("returns [] for an empty task list", () => {
    expect(runTasks([])).toEqual([]);
  });

  it("supports Uint8Array inputs only (bytes — no string coercion)", () => {
    // Every op takes Uint8Array; a randomToken round is deterministic length.
    const res = runTasks([{ op: "randomToken", byteLen: 8 }] as const);
    const [rt] = res as [TaskResult];
    expect((rt.value as Uint8Array).length).toBe(16);
    expect(randomToken(8).length).toBe(16);
  });
});
