/**
 * @fileoverview Runtime-native scalar/string reads over native output buffers.
 *
 * The helpers are OWNED by castrum (`@ignex/castrum/native`) and delegated to
 * when that package is reachable — resolved LAZILY through `require`, never
 * statically imported. A static edge here becomes a fatal top-level import in
 * every AOT-generated server bundle: the linker externalizes `@ignex/castrum*`
 * and the bundle lives in the app's dist directory, BELOW castrum's real home
 * (`packages/native/node_modules`), where bare-specifier resolution cannot
 * reach it (the CI quality lane booted exactly such servers and died with
 * `Cannot find module '@ignex/castrum/native'`; a workspace-root `bun link`
 * masks this locally). When castrum cannot be resolved, byte-identical local
 * implementations take over: bun:ffi fast reads under Bun, DataView/
 * TextDecoder elsewhere. Native is acceleration, never a hard dependency.
 */

import { createRequire } from "node:module";
import { decoder } from "./util";

/** Castrum's read-helper surface (type-only import — erased at runtime). */
type CastrumRead = Pick<
  typeof import("@ignex/castrum/native"),
  "ffiBuf" | "ffiString" | "ffiU32" | "ffiU64"
>;

let castrumRead: CastrumRead | null | undefined;

/**
 * Resolve castrum's read helpers once, on first use. Two rungs: a direct
 * require (unbundled runs — castrum is this package's own dependency), then
 * the core → native package ladder for AOT bundles, whose `import.meta.url`
 * is the app's dist directory (mirrors loader/native.ts's
 * `resolveNativeModuleUrl`). Memoizes `null` when nothing resolves, so a
 * missing-castrum host pays exactly one failed lookup.
 */
const resolveCastrumRead = (): CastrumRead | null => {
  if (castrumRead !== undefined) return castrumRead;
  const req = createRequire(import.meta.url);
  const rungs: Array<() => string> = [
    () => req.resolve("@ignex/castrum/native"),
    () =>
      createRequire(createRequire(req.resolve("@ignex/core")).resolve("@ignex/native")).resolve(
        "@ignex/castrum/native",
      ),
  ];
  for (const rung of rungs) {
    try {
      const mod = req(rung()) as Partial<CastrumRead>;
      if (
        typeof mod.ffiBuf === "function" &&
        typeof mod.ffiString === "function" &&
        typeof mod.ffiU32 === "function" &&
        typeof mod.ffiU64 === "function"
      ) {
        castrumRead = mod as CastrumRead;
        return castrumRead;
      }
    } catch {
      // rung unreachable — fall through to the next one
    }
  }
  castrumRead = null;
  return castrumRead;
};

/** Structural view of the `bun:ffi` read/ptr/CString surface (no bun types). */
interface BunFfiRead {
  read: { u32(ptr: number, offset?: number): number; u64(ptr: number, offset?: number): bigint };
  ptr(buffer: Uint8Array): number;
  CString: new (ptr: number, byteOffset?: number, byteLength?: number) => string;
}

// Local fallback transport, probed once at module load: `bun:ffi` under Bun,
// `null` elsewhere (the DataView/TextDecoder readers below take over).
let bunFfi: BunFfiRead | null = null;
try {
  const mod = createRequire(import.meta.url)("bun:ffi") as Partial<BunFfiRead>;
  bunFfi =
    mod.read && typeof mod.ptr === "function" && typeof mod.CString === "function"
      ? (mod as BunFfiRead)
      : null;
} catch {
  bunFfi = null;
}

/**
 * A native output buffer pinned for fast reads. Under Bun `p` is the buffer's
 * pointer (resolved once, so hot loops never re-call `ptr()`); under Node `p`
 * is unused and `buf` drives the DataView fallback.
 */
export interface FfiBuf {
  readonly p: number;
  readonly buf: Uint8Array;
}

const localBuf = (buf: Uint8Array): FfiBuf =>
  bunFfi ? { p: bunFfi.ptr(buf), buf } : { p: 0, buf };

const fallbackView = (buf: Uint8Array): DataView =>
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

const localU32 = (b: FfiBuf, offset: number): number =>
  bunFfi ? bunFfi.read.u32(b.p, offset) : fallbackView(b.buf).getUint32(offset, true);

const localU64 = (b: FfiBuf, offset: number): bigint =>
  bunFfi ? bunFfi.read.u64(b.p, offset) : fallbackView(b.buf).getBigUint64(offset, true);

const localString = (b: FfiBuf, offset: number, len: number): string => {
  // Bun's CString rejects a 0 byteLength — emit "" for empty values.
  if (len === 0) return "";
  return bunFfi
    ? new bunFfi.CString(b.p, offset, len)
    : decoder.decode(b.buf.subarray(offset, offset + len));
};

/** Pin a buffer for repeated fast reads (resolve the pointer once). */
export const ffiBuf = (buf: Uint8Array): FfiBuf =>
  resolveCastrumRead()?.ffiBuf(buf) ?? localBuf(buf);

/** Read a little-endian u32 from `b` at byte `offset`. */
export const ffiU32 = (b: FfiBuf, offset: number): number =>
  resolveCastrumRead()?.ffiU32(b, offset) ?? localU32(b, offset);

/** Read a little-endian u64 from `b` at byte `offset`. */
export const ffiU64 = (b: FfiBuf, offset: number): bigint =>
  resolveCastrumRead()?.ffiU64(b, offset) ?? localU64(b, offset);

/** Read a UTF-8 string of `len` bytes from `b` at byte `offset`. */
export const ffiString = (b: FfiBuf, offset: number, len: number): string =>
  resolveCastrumRead()?.ffiString(b, offset, len) ?? localString(b, offset, len);
