/**
 * Pooled `flatbuffers.ByteBuffer` — avoids allocating a fresh ByteBuffer (and
 * the new `TextDecoder` its constructor creates) for every decoded frame.
 *
 * Why this is safe:
 *   - `flatbuffers.ByteBuffer` stores its backing view in a stable internal
 *     field (`bytes_`) and its read offset in `position_` (plain JS properties
 *     in v25). The read offset also has a public `setPosition()`.
 *   - Decoding is SYNCHRONOUS and the generated `.unpack()`/`*ToPlain` path
 *     fully materializes the plain-object payload before `decodePayload`
 *     returns — nothing reads the ByteBuffer afterwards, and no lazy reference
 *     to the frame bytes escapes (strings are decoded eagerly via
 *     `text_decoder_`, vectors are copied into fresh arrays).
 *   - Therefore a single reused instance can be re-pointed at each new frame.
 *
 * Robustness: the first use verifies the internal `bytes_` field exists. If a
 * future flatbuffers version renames it, we fall back to constructing a fresh
 * ByteBuffer per call (the previous behavior). Browser-safe (imports only
 * `flatbuffers`), so the generated registry (used by the client bundle) can use
 * it.
 */
import * as flatbuffers from "flatbuffers";

let pooled: flatbuffers.ByteBuffer | null = null;
/** null = not probed yet; true = pooling works; false = use fresh per call. */
let usable: boolean | null = null;

function probe(): boolean {
  const bb = new flatbuffers.ByteBuffer(new Uint8Array(1));
  return (bb as unknown as { bytes_?: Uint8Array }).bytes_ instanceof Uint8Array;
}

/**
 * Return a ByteBuffer viewing `bytes`, positioned at `pos` (a RELATIVE index
 * into `bytes`, i.e. the wire envelope length — flatbuffers reads are
 * `bytes_[offset]`, relative to the view's start, so `position_` must be
 * relative too, NOT `bytes.byteOffset + pos`). Reuses a single pooled instance
 * when the running flatbuffers version supports it; otherwise constructs a
 * fresh one (also positioned) — the previous behavior.
 */
export function pooledByteBuffer(bytes: Uint8Array, pos: number): flatbuffers.ByteBuffer {
  if (usable === false) {
    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(pos);
    return bb;
  }
  if (usable === null) usable = probe();
  if (!usable) {
    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(pos);
    return bb;
  }
  if (!pooled) pooled = new flatbuffers.ByteBuffer(bytes);
  (pooled as unknown as { bytes_: Uint8Array }).bytes_ = bytes;
  pooled.setPosition(pos);
  return pooled;
}

/** @internal test hook — force the fresh-per-call fallback path. */
export function __forceFreshPoolForTest(force: boolean): void {
  usable = force ? false : null;
  pooled = null;
}
