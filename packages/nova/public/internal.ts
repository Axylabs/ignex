/**
 * Public internal-helper entrypoint — `ignex-nova/internal`.
 *
 * Generated code (from `ignex-nova/generate`) imports these runtime helpers so
 * user projects don't reach into the package's private modules:
 *
 *   - `encodeUtf8Into` / `ensureCapacity` / `utf8Len` — zero-alloc UTF-8
 *     helpers used by the generated direct fast-path encoders.
 *   - `checkInt64` — lossless-int64 guard for plain `number` int64 fields.
 *   - `pooledByteBuffer` — pooled flatbuffers.ByteBuffer used by the generated
 *     registry's decoders.
 */

export { checkInt64, setInt64GuardMode } from "../src/core/int64-guard";
export { encodeUtf8Into, ensureCapacity, utf8Len } from "../src/native/codec";
export { pooledByteBuffer } from "../src/transport/byte-buffer-pool";
