/**
 * Parity tests for the native BATCH surface (`@ignex/native` `batch`).
 *
 * The batch path is one packed FFI call for many items; it must agree
 * per-item with the scalar surface. Runs against the real addon when
 * available (`IGNEX_NATIVE_PATH` / castrum installed), else the pure-TS
 * per-item fallback — either way the batch and scalar results must match
 * bit-for-bit.
 */

import {
  batch,
  cookiePairs,
  crc32,
  csrfToken,
  csrfVerify,
  fnv1a64,
  formPairs,
  hmacSha256,
  jsonValid,
  queryPairs,
  signCookie,
  verifyCookie,
} from "@ignex/native";
import { describe, expect, it } from "vitest";

const enc = new TextEncoder();

const JSONS = [
  '{"a":1,"b":[true,null,"x"]}',
  '{"a":1, broken',
  "[]",
  "",
  '{"x": {"y": [1, 2, 3]}}',
  "null",
  "[1,2,3]",
  "nope",
  "42",
];
const CRCS = ["", "a", "foobar", "hello world", "x".repeat(64), "123456789"];
const FNVS = ["", "a", "foobar", "castrum", "key-0", "x".repeat(128)];
const QUERIES = [
  "a=1&b=2",
  "a=1&a=2&b=x+y",
  "q=hello%20world&n=42&flag",
  "",
  "x=%E2%9C%93&y=%26%3D",
  "key=",
];
const COOKIES = [
  "session=abc123; theme=dark; lang=en-US",
  'a=1; b="quoted value"; c=',
  "",
  "flag",
  "x=1; y=2; y=3",
];
const FORMS = ["a=1&b=2", "name=John+Doe&age=30", "", "note=%E2%9C%93&multi=a&multi=b"];

const bits = (items: readonly boolean[]): readonly number[] => items.map((b) => (b ? 1 : 0));

describe("batch parity (batch result must equal per-item scalar)", () => {
  it("jsonValid batch == per-item scalar", () => {
    expect([...batch.jsonValid(JSONS)]).toEqual(bits(JSONS.map(jsonValid)));
  });

  it("crc32 batch == per-item scalar (unsigned)", () => {
    const expected = CRCS.map((c) => crc32(c) >>> 0);
    expect([...batch.crc32(CRCS)]).toEqual(expected);
  });

  it("fnv1a64 batch == per-item scalar (unsigned bigint)", () => {
    const expected = FNVS.map((f) => fnv1a64(f));
    expect([...batch.fnv1a64(FNVS)]).toEqual(expected);
  });

  it("accepts Uint8Array inputs identically to strings", () => {
    expect([...batch.jsonValid(JSONS.map((j) => enc.encode(j)))]).toEqual([
      ...batch.jsonValid(JSONS),
    ]);
    expect([...batch.fnv1a64(FNVS.map((f) => enc.encode(f)))]).toEqual([...batch.fnv1a64(FNVS)]);
  });

  it("handles an empty batch", () => {
    expect([...batch.jsonValid([])]).toEqual([]);
    expect([...batch.crc32([])]).toEqual([]);
    expect([...batch.fnv1a64([])]).toEqual([]);
    expect(batch.queryParse([])).toEqual([]);
    expect(batch.cookieParse([])).toEqual([]);
    expect(batch.formParse([])).toEqual([]);
  });

  it("queryParse batch == per-item scalar", () => {
    expect(batch.queryParse(QUERIES)).toEqual(QUERIES.map((q) => queryPairs(q)));
  });

  it("cookieParse batch == per-item scalar", () => {
    expect(batch.cookieParse(COOKIES)).toEqual(COOKIES.map((c) => cookiePairs(c)));
  });

  it("formParse batch == per-item scalar", () => {
    expect(batch.formParse(FORMS)).toEqual(FORMS.map((f) => formPairs(f)));
  });

  it("pair batches accept Uint8Array inputs identically to strings", () => {
    expect(batch.queryParse(QUERIES.map((q) => enc.encode(q)))).toEqual(batch.queryParse(QUERIES));
    expect(batch.cookieParse(COOKIES.map((c) => enc.encode(c)))).toEqual(
      batch.cookieParse(COOKIES),
    );
    expect(batch.formParse(FORMS.map((f) => enc.encode(f)))).toEqual(batch.formParse(FORMS));
  });
});

// ── Crypto batch parity (added 2026-08-14 from bench/results/batch-selection.json) ──
const SECRET = enc.encode("s3cret-key-material-0123456789abcdef");
const HKEY = enc.encode("key-material-0123456789abcdef");
const SIGN_VALUES = ["session=abc123", "theme=dark", "x=1", "user_id=42"];

const bytesEq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

describe("crypto batch parity (batch must equal per-item scalar)", () => {
  it("signCookie batch == per-item scalar (byte-equal `value.<64hex>`)", () => {
    const expected = SIGN_VALUES.map((v) => enc.encode(signCookie(v, SECRET)));
    const got = batch.signCookie(SIGN_VALUES, SECRET);
    expect(got).toHaveLength(SIGN_VALUES.length);
    got.forEach((g, i) => {
      expect(bytesEq(g, expected[i] as Uint8Array)).toBe(true);
    });
  });

  it("verifyCookie batch == per-item scalar (all valid, tampered rejected)", () => {
    const signed = SIGN_VALUES.map((v) => signCookie(v, SECRET));
    const tampered = signed.map((s, i) =>
      i === 0 ? s.slice(0, -1) + (s.endsWith("a") ? "b" : "a") : s,
    );
    const expected = signed.map((s) => (verifyCookie(s, SECRET) !== null ? 1 : 0));
    expect([...batch.verifyCookie(signed, SECRET)]).toEqual(expected);
    // tampered first item must fail
    expect([...batch.verifyCookie(tampered, SECRET)][0]).toBe(0);
  });

  it("csrfVerify batch == per-item scalar", () => {
    const token = csrfToken(SECRET);
    expect([...batch.csrfVerify([token], SECRET)]).toEqual([csrfVerify(token, SECRET) ? 1 : 0]);
    expect([...batch.csrfVerify([token, token, "garbage"], SECRET)]).toEqual([1, 1, 0]);
  });

  it("hmacSha256 batch == per-item scalar (64 lowercase-hex bytes)", () => {
    const values = ["payload-a", "payload-b", "payload-c"];
    const expected = values.map((v) => hmacSha256(HKEY, v));
    const got = batch.hmacSha256(values, HKEY);
    got.forEach((g, i) => {
      expect(bytesEq(g, expected[i] as Uint8Array)).toBe(true);
    });
    // 64 hex chars
    got.forEach((g) => {
      expect(g).toHaveLength(64);
    });
  });

  it("hmacSha256Verify batch == per-item scalar (valid + tampered)", () => {
    const values = ["payload-a", "payload-b", "payload-c"];
    const sigs = values.map((v) => hmacSha256(HKEY, v));
    expect([...batch.hmacSha256Verify(values, sigs, HKEY)]).toEqual([1, 1, 1]);
    const badSigs = sigs.map((s, i) => (i === 1 ? new Uint8Array(s).fill(0) : s));
    expect([...batch.hmacSha256Verify(values, badSigs, HKEY)]).toEqual([1, 0, 1]);
  });

  it("crypto batches handle an empty batch", () => {
    expect(batch.signCookie([], SECRET)).toEqual([]);
    expect([...batch.verifyCookie([], SECRET)]).toEqual([]);
    expect([...batch.csrfVerify([], SECRET)]).toEqual([]);
    expect(batch.hmacSha256([], HKEY)).toEqual([]);
    expect([...batch.hmacSha256Verify([], [], HKEY)]).toEqual([]);
  });
});
