/**
 * @fileoverview Packed v1 metrics-snapshot decode — the wire struct map for
 * castrum's `MetricsRegistry::snapshot_into` dump, plus the family metadata
 * the decoder and both registries keep.
 *
 * Extracted from the pre-split `metrics.ts` (move-only); imports only
 * `./types`; consumed by `./registry-native` and `./registry-fallback`.
 */

import type { RegistrySnapshot } from "./types";

/** Declared family metadata (index == family id in snapshot/render). */
export interface FamilyMeta {
  name: string;
  kind: 0 | 1 | 2;
  keys: string[];
  buckets: number[];
  /** Live series count for this family (recomputed per snapshot/render). */
  seriesCount: number;
}

/** UTF-8 decoder reused for snapshot strings. */
export const snapshotDecoder = new TextDecoder();

/**
 * Decode the packed v1 snapshot (see castrum `MetricsRegistry::snapshot_into`)
 * into the {@link RegistrySnapshot} shape. `families` must be the declaring
 * registry's metadata (index == family id).
 */
export const decodeMetricsSnapshot = (bytes: Uint8Array): RegistrySnapshot => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const u32 = (): number => {
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const f64 = (): number => {
    const v = dv.getFloat64(off, true);
    off += 8;
    return v;
  };
  const u64 = (): number => {
    const v = dv.getBigUint64(off, true);
    off += 8;
    return Number(v);
  };
  const str = (len: number): string => {
    const s = snapshotDecoder.decode(bytes.subarray(off, off + len));
    off += len;
    return s;
  };

  u32(); // version (currently always 1)
  const metas: FamilyMeta[] = [];
  const famCount = u32();
  for (let i = 0; i < famCount; i++) {
    u32(); // familyId == index
    const kind = bytes[off] as 0 | 1 | 2;
    off += 1;
    const name = str(u32());
    const keysLen = u32();
    const keys = keysLen === 0 ? [] : str(keysLen).split("\u001f");
    const nBuckets = u32();
    const buckets: number[] = Array.from({ length: nBuckets });
    for (let b = 0; b < nBuckets; b++) buckets[b] = f64();
    metas.push({ name, kind, keys, buckets, seriesCount: 0 });
  }

  const counters: RegistrySnapshot["counters"] = [];
  const histograms: RegistrySnapshot["histograms"] = [];
  const seriesCount = u32();
  for (let i = 0; i < seriesCount; i++) {
    const fam = metas[u32()] as FamilyMeta | undefined;
    if (fam === undefined) throw new Error("metrics snapshot: unknown family id");
    const valsLen = u32();
    const vals = valsLen === 0 ? [] : str(valsLen).split("\u001f");
    const labels: Record<string, string> = {};
    for (let k = 0; k < fam.keys.length; k++) labels[fam.keys[k] as string] = vals[k] ?? "";
    if (fam.kind === 2) {
      const sum = f64();
      const count = u64();
      let cumulative = 0;
      const buckets = fam.buckets.map((le) => {
        cumulative += u64();
        return { le, count: cumulative };
      });
      histograms.push({ name: fam.name, labels, count, sum, buckets });
    } else {
      counters.push({ name: fam.name, labels, value: f64() });
    }
  }
  return { counters, histograms };
};
