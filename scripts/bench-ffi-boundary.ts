#!/usr/bin/env bun
/**
 * The cost of the JS↔Rust boundary, pinned — signature by signature.
 *
 * `docs/aot-perf-plan.md` §22 closed the "can this move to Rust?" question with
 * "≥1.3 µs per FFI crossing". That figure is the NAPI transport, not the C-ABI
 * crossing (`scripts/bench-ffi.ts` says so in its own header: ~10–20 ns here vs
 * ~100–350 ns on NAPI). The difference decides an architecture, so it is
 * measured here rather than argued: **the crossing is free; MARSHALLING is the
 * cost.** See §37 for what that does and does not license.
 *
 *   A  the crossing by signature — why a no-arg libc call looks like 300 ns of
 *      FFI when it is 300 ns of syscall
 *   B  `usize` returns arrive boxed as BigInt → keep route ABIs on u32/i32
 *   C  a JS `Uint8Array`/`ArrayBuffer` is a `ptr` ARG with NO copy; a `string`
 *      is rejected outright (encode-then-transcode, §36)
 *   D  `new Response(view)` COPIES at construction → a native output buffer
 *      needs no lifetime protocol
 *   E  the two real pipelines: what the framework pays today vs Rust bytes
 *
 *   bun scripts/bench-ffi-boundary.ts
 */
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";

const LIBC = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";

const libc = dlopen(LIBC, {
  getpid: { args: [], returns: FFIType.i32 },
  abs: { args: [FFIType.i32], returns: FFIType.i32 },
  strlen: { args: [FFIType.ptr], returns: FFIType.u64 },
  memcpy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  memset: { args: [FFIType.ptr, FFIType.i32, FFIType.u64], returns: FFIType.ptr },
  malloc: { args: [FFIType.u64], returns: FFIType.ptr },
});

// The same symbol with a `u64_fast` return: a JS number instead of a boxed BigInt.
const libcFast = dlopen(LIBC, { strlen: { args: [FFIType.ptr], returns: FFIType.u64_fast } });

// Per-symbol casts, through `unknown` (the declared arg union is BigInt/TypedArray/
// Pointer, which does not overlap a plain number).
type Ptr = number;
const getpid = libc.symbols.getpid as unknown as () => number;
const abs = libc.symbols.abs as unknown as (n: number) => number;
const strlenU64 = libc.symbols.strlen as unknown as (p: Ptr) => bigint;
const strlenFast = libcFast.symbols.strlen as unknown as (p: Ptr) => number;
const memcpy = libc.symbols.memcpy as unknown as (dst: Ptr, src: Ptr, n: number) => Ptr;
const memset = libc.symbols.memset as unknown as (p: Ptr, v: number, n: number) => Ptr;
const memsetView = libc.symbols.memset as unknown as (p: Uint8Array, v: number, n: number) => Ptr;
const malloc = libc.symbols.malloc as unknown as (n: number) => Ptr;

let SINK = 0;
const ROUNDS = 7;
const ITERS = 200_000;

/** Median ns/call over ROUNDS trials (drift hits every row equally). */
function bench(label: string, fn: () => number | bigint): number {
  const trials: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < 20_000; i++) SINK += Number(fn());
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) SINK += Number(fn());
    trials.push(((performance.now() - t0) * 1e6) / ITERS);
  }
  trials.sort((a, b) => a - b);
  const median = trials[Math.floor(ROUNDS / 2)] ?? 0;
  console.log(`  ${label.padEnd(52)} ${median.toFixed(2).padStart(8)} ns`);
  return median;
}

const buf = malloc(1024);
memset(buf, 65, 512);
const nul = malloc(8);
memset(nul, 0, 8);

console.log("A/B. the crossing, by signature (median of 7)");
const jsCall = bench("empty arrow fn  [JS floor]", () => 0);
const i32 = bench("abs(7)          [i32]->i32", () => abs(7));
const usize0 = bench("strlen(NUL)     0 work, u64 return (BigInt)", () => strlenU64(nul));
const usizeFast = bench("strlen(NUL)     same, u64_fast return (number)", () => strlenFast(nul));
const usizeN = bench("strlen(ptr)     256B scan, u64 return", () => strlenU64(buf));
const three = bench("memcpy(p,p,64)  [ptr,ptr,u64]->ptr", () => memcpy(buf, buf, 64));
const syscall = bench("getpid()        []->i32", () => getpid());

console.log("\nC. zero-copy into Rust: a TypedArray as a `ptr` arg");
const view = new Uint8Array(16);
const taPtr = bench("memset(Uint8Array as ptr, 16B)", () => memsetView(view, 90, 16));
let strRejected = "accepted";
try {
  (libc.symbols.strlen as unknown as (p: string) => bigint)("hello");
} catch (err) {
  strRejected = (err as Error).message;
}

console.log("\nD. does `new Response(view)` alias or copy the native bytes?");
const p = malloc(64);
memset(p, 65, 8);
const nativeView = new Uint8Array(toArrayBuffer(p, 0, 8));
const early = new Response(nativeView);
nativeView[0] = 90;
memset(p, 90, 1);
const bodyAfter = await early.text();
const aliased = bodyAfter.startsWith("Z");
console.log(
  `  mutated the source view AND the native bytes, body reads ${JSON.stringify(bodyAfter)} →`,
  aliased ? "ALIASED (a lifetime protocol would be required)" : "COPIED at construction",
);

console.log("\nE. the two pipelines, 1KB JSON object");
const obj = {
  ok: true,
  items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}` })),
};
const payload = JSON.stringify(obj);
const arena = malloc(65536);
memset(arena, 120, payload.length);
const wrap = () => new Response(new Uint8Array(toArrayBuffer(arena, 0, payload.length))).status;
const wrapOnly = bench(
  `toArrayBuffer + Uint8Array  (${payload.length}B)`,
  () => new Uint8Array(toArrayBuffer(arena, 0, payload.length)).length,
);
const rustPath = bench("Rust path: wrap + new Response(bytes)", wrap);
const stringifyPath = bench(
  "today:     new Response(JSON.stringify)",
  () => new Response(JSON.stringify(obj)).status,
);
const jsonPath = bench("today:     Response.json(obj)", () => Response.json(obj).status);
const parsePath = bench("today:     JSON.parse(payload)  [a POST]", () =>
  (JSON.parse(payload) as { ok: boolean }).ok ? 1 : 0,
);
const encodePath = bench(
  "encode:    TextEncoder.encode(payload)",
  () => new TextEncoder().encode(payload).length,
);

console.log("\n--- derived ---");
console.log(
  `  crossing (i32)                 ${i32.toFixed(2)} ns  (+${(i32 - jsCall).toFixed(2)} over a JS call)`,
);
console.log(
  `  u64 return boxes a BigInt      +${(usize0 - i32).toFixed(2)} ns  → ${usizeFast.toFixed(2)} ns via u64_fast (no box)`,
);
console.log(`  array scan of 256B             +${(usizeN - usize0).toFixed(2)} ns`);
console.log(`  3-arg ptr call                 ${three.toFixed(2)} ns`);
console.log(
  `  TypedArray as ptr arg          ${taPtr.toFixed(2)} ns  → not copied (view[0]=${view[0]})`,
);
console.log(`  string as ptr arg              rejected: ${strRejected}`);
console.log(`  no-arg libc call               ${syscall.toFixed(2)} ns  → a syscall, NOT FFI`);
console.log(
  `  toArrayBuffer wrap             ${wrapOnly.toFixed(2)} ns  (${(wrapOnly / i32).toFixed(0)}x a crossing) → marshalling is the cost`,
);
console.log(
  `  new Response(view)             ${aliased ? "ALIASED (needs a lifetime protocol!)" : "COPIES at construction → free/reuse the buffer immediately"}`,
);
console.log(
  `  Rust bytes vs Response.json    ${rustPath.toFixed(2)} vs ${jsonPath.toFixed(2)} ns  ⇒ ${(jsonPath / rustPath).toFixed(1)}x`,
);
console.log(
  `  (Response.json vs stringify     ${jsonPath.toFixed(2)} vs ${stringifyPath.toFixed(2)} ns)`,
);
console.log(
  `  post: parse bytes vs req.json  ${parsePath.toFixed(2)} ns (in Rust: +${encodePath.toFixed(2)} encode + one crossing)`,
);
console.log(`\n  (sink ${SINK.toFixed(0)})`);
