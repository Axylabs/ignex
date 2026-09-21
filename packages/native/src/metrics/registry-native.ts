/**
 * @fileoverview Native-backed metrics registry — the C-ABI/bun:ffi fast path
 * with the NAPI-plus fallback inside `createNativeMetricsRegistry`. Shared
 * helpers live in `./shared`; the byte-compatible pure-TS twin is
 * `./registry-fallback`.
 *
 * Extracted from the pre-split `metrics.ts` (move-only).
 */

import { type FfiMetricsSurface, getFfiMetrics } from "../ffi";
import { native } from "../runtime";
import { decodeMetricsSnapshot, type FamilyMeta, snapshotDecoder } from "./decode";
import { DEFAULT_BUCKETS, sanitizeBuckets, sortedKeys } from "./shared";
import type {
  MetricsRegistryLike,
  MetricsRegistryOptions,
  RegistryCounter,
  RegistryHistogram,
  RegistrySnapshot,
} from "./types";

// ── Native-backed ───────────────────────────────────────────────────────────

interface NativeRegistry {
  counter(name: string, labelKeys: string[]): number;
  histogram(name: string, labelKeys: string[], buckets: number[]): number;
  record(series: number, values: string[], amount: number): void;
  render(): string;
  snapshot(): Uint8Array;
}

/**
 * C-ABI-backed registry: one `Box<MetricsRegistry>` per instance, updates via
 * `castrum_metrics_record_str` (label VALUES cross as a single joined
 * `cstring` ARG — zero JS encode) and reads via `render`/`snapshot`.
 */
function createFfiBacked(
  ffi: FfiMetricsSurface,
  options: MetricsRegistryOptions,
): MetricsRegistryLike {
  const handle = ffi.metricsCreate();
  const defaultBuckets = [...(options.histogramBuckets ?? DEFAULT_BUCKETS)];
  type Series = { id: number; keys: string[] };
  const counterSeries = new Map<string, Series>();
  const histSeries = new Map<string, Series>();
  /** Hint-addressed views (hot lane). */
  const counterHintViews = new Map<string, RegistryCounter>();
  const histHintViews = new Map<string, RegistryHistogram>();
  const familiesMeta: FamilyMeta[] = [];
  let snapshotCache: Uint8Array = new Uint8Array(0);

  const remember = (id: number, name: string, kind: 0 | 1 | 2, keys: string[], fb: number[]) => {
    familiesMeta[id] = { name, kind, keys, buckets: fb, seriesCount: 0 };
  };

  /** Grow-once read of a needed-size op into a stable buffer. */
  const readInto = (op: (h: number, out: Uint8Array) => number): Uint8Array => {
    let out = snapshotCache.byteLength >= 4096 ? snapshotCache : new Uint8Array(4096);
    let w = op(handle, out);
    if (w > out.length) {
      out = new Uint8Array(w);
      w = op(handle, out);
    }
    snapshotCache = out;
    return out.subarray(0, w);
  };

  return {
    counter(name, labels = {}, hint) {
      const keys = sortedKeys(labels);
      const cacheKey = `${name}|${keys.join(",")}`;
      let s = counterSeries.get(cacheKey);
      if (s === undefined) {
        const id = ffi.metricsCounter(handle, name, keys.join("\u001f"));
        remember(id, name, 0, keys, []);
        s = { id, keys };
        counterSeries.set(cacheKey, s);
      }
      if (hint !== undefined) {
        let v = counterHintViews.get(hint);
        if (v === undefined) {
          const valsArr = keys.map((k) => labels[k] ?? "");
          v = {
            inc(by = 1) {
              ffi.metricsRecordStr(handle, id, valsArr.join("\u001f"), by);
            },
            get value(): number {
              const want = valsArr;
              return (
                decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).counters.find(
                  (c) => c.name === name && ks.every((k, i) => c.labels[k] === want[i]),
                )?.value ?? 0
              );
            },
          };
          counterHintViews.set(hint, v);
        }
        return v;
      }
      const { id, keys: ks } = s;
      return {
        inc(by = 1) {
          ffi.metricsRecordStr(handle, id, ks.map((k) => labels[k] ?? "").join("\u001f"), by);
        },
        get value(): number {
          const want = ks.map((k) => labels[k] ?? "");
          return (
            decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).counters.find(
              (c) => c.name === name && ks.every((k, i) => c.labels[k] === want[i]),
            )?.value ?? 0
          );
        },
      };
    },

    histogram(name, labels = {}, customBuckets, hint) {
      const keys = sortedKeys(labels);
      if (hint !== undefined) {
        let v = histHintViews.get(hint);
        if (v === undefined) {
          const effective = customBuckets ? sanitizeBuckets(customBuckets) : defaultBuckets;
          const id = ffi.metricsHistogram(handle, name, keys.join("\u001f"), effective.join(","));
          remember(id, name, 2, keys, effective);
          const valsArr = keys.map((k) => labels[k] ?? "");
          v = {
            observe(value) {
              ffi.metricsRecordStr(handle, id, valsArr.join("\u001f"), value);
            },
            get count(): number {
              const want = valsArr;
              return (
                decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).histograms.find(
                  (x) => x.name === name && ks.every((k, i) => x.labels[k] === want[i]),
                )?.count ?? 0
              );
            },
            get sum(): number {
              const want = valsArr;
              return (
                decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).histograms.find(
                  (x) => x.name === name && ks.every((k, i) => x.labels[k] === want[i]),
                )?.sum ?? 0
              );
            },
            get buckets(): RegistrySnapshot["histograms"][number]["buckets"] {
              const want = valsArr;
              return (
                decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).histograms.find(
                  (x) => x.name === name && ks.every((k, i) => x.labels[k] === want[i]),
                )?.buckets ?? []
              );
            },
          };
          histHintViews.set(hint, v);
        }
        return v;
      }
      const cacheKey = `${name}|${keys.join(",")}`;
      let s = histSeries.get(cacheKey);
      if (s === undefined) {
        const effective = customBuckets ? sanitizeBuckets(customBuckets) : defaultBuckets;
        const id = ffi.metricsHistogram(handle, name, keys.join("\u001f"), effective.join(","));
        remember(id, name, 2, keys, effective);
        s = { id, keys };
        histSeries.set(cacheKey, s);
      }
      const { id, keys: ks } = s;
      return {
        observe(value) {
          ffi.metricsRecordStr(handle, id, ks.map((k) => labels[k] ?? "").join("\u001f"), value);
        },
        get count(): number {
          const want = ks.map((k) => labels[k] ?? "");
          return (
            decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).histograms.find(
              (x) => x.name === name && ks.every((k, i) => x.labels[k] === want[i]),
            )?.count ?? 0
          );
        },
        get sum(): number {
          const want = ks.map((k) => labels[k] ?? "");
          return (
            decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).histograms.find(
              (x) => x.name === name && ks.every((k, i) => x.labels[k] === want[i]),
            )?.sum ?? 0
          );
        },
        get buckets(): RegistrySnapshot["histograms"][number]["buckets"] {
          const want = ks.map((k) => labels[k] ?? "");
          return (
            decodeMetricsSnapshot(readInto(ffi.metricsSnapshot)).histograms.find(
              (x) => x.name === name && ks.every((k, i) => x.labels[k] === want[i]),
            )?.buckets ?? []
          );
        },
      };
    },

    renderPrometheus() {
      const bytes = readInto(ffi.metricsRender);
      return snapshotDecoder.decode(bytes);
    },

    snapshot(): RegistrySnapshot {
      return decodeMetricsSnapshot(readInto(ffi.metricsSnapshot));
    },

    destroy() {
      ffi.metricsDestroy(handle);
    },
  };
}

/**
 * Create a NATIVE-backed metrics registry. Throws when the castrum addon is
 * unavailable — callers fall back to their pure-TS implementation
 * ({@link createMetricsRegistryFallback} here, or `@ignex/core`'s own).
 *
 * A fresh view object is returned per `counter()`/`histogram()` call and
 * closes over THAT call's labels object (values vary per event); the series
 * id + sorted key order are what get cached, so the only per-event costs are
 * `Object.keys().sort()`, the values join, and one native record.
 */
export const createNativeMetricsRegistry = (
  options: MetricsRegistryOptions = {},
): MetricsRegistryLike => {
  // Fastest transport first: the C-ABI surface with a caller-owned registry
  // handle (~10-20ns crossing + cstring label values). Falls back to the NAPI
  // class when bun:ffi is unavailable or the addon predates these symbols.
  const ffiM = getFfiMetrics();
  if (ffiM) return createFfiBacked(ffiM, options);
  const ctor = (native as unknown as { MetricsRegistry?: new () => NativeRegistry })
    .MetricsRegistry;
  if (!ctor) throw new Error("createNativeMetricsRegistry requires the castrum addon");
  const inst = new ctor();

  const defaultBuckets = [...(options.histogramBuckets ?? DEFAULT_BUCKETS)];

  type Series = { id: number; keys: string[] };
  const counterSeries = new Map<string, Series>();
  const histSeries = new Map<string, Series>();
  /** Hint-addressed views (hot lane). */
  const counterHintViews = new Map<string, RegistryCounter>();
  const histHintViews = new Map<string, RegistryHistogram>();
  const familiesMeta: FamilyMeta[] = [];

  const remember = (id: number, name: string, kind: 0 | 1 | 2, keys: string[], fb: number[]) => {
    familiesMeta[id] = { name, kind, keys, buckets: fb, seriesCount: 0 };
  };

  /** COLD read of one series through a fresh snapshot decode (getters only). */
  const readSeries = (
    name: string,
    keys: string[],
    vals: string,
    kind: 0 | 1 | 2,
  ): { value?: number; hist?: RegistrySnapshot["histograms"][number] } => {
    const snap = decodeMetricsSnapshot(inst.snapshot());
    const want = vals.split("\u001f");
    if (kind === 0) {
      const c = snap.counters.find(
        (x) => x.name === name && keys.every((k) => x.labels[k] === want[keys.indexOf(k)]),
      );
      return c ? { value: c.value } : {};
    }
    const h = snap.histograms.find(
      (x) => x.name === name && keys.every((k) => x.labels[k] === want[keys.indexOf(k)]),
    );
    return h ? { hist: h } : {};
  };

  return {
    counter(name, labels = {}, hint) {
      const keys = sortedKeys(labels);
      const cacheKey = `${name}|${keys.join(",")}`;
      let s = counterSeries.get(cacheKey);
      if (s === undefined) {
        const id = inst.counter(name, keys);
        remember(id, name, 0, keys, []);
        s = { id, keys };
        counterSeries.set(cacheKey, s);
      }
      if (hint !== undefined) {
        let v = counterHintViews.get(hint);
        if (v === undefined) {
          const valsArr = keys.map((k) => labels[k] ?? "");
          v = {
            inc(by = 1) {
              inst.record(id, valsArr, by);
            },
            get value(): number {
              return readSeries(name, keys, valsArr.join("\u001f"), 0).value ?? 0;
            },
          };
          counterHintViews.set(hint, v);
        }
        return v;
      }
      const { id, keys: ks } = s;
      return {
        inc(by = 1) {
          inst.record(
            id,
            ks.map((k) => labels[k] ?? ""),
            by,
          );
        },
        get value(): number {
          return (
            readSeries(name, keys, ks.map((k) => labels[k] ?? "").join("\u001f"), 0).value ?? 0
          );
        },
      };
    },

    histogram(
      name: string,
      labels: Record<string, string> = {},
      customBuckets: readonly number[] | undefined,
      hint: string | undefined,
    ) {
      const keys = sortedKeys(labels);
      // Family identity is (name + label KEYS): the FIRST declaration's
      // buckets win for the lifetime of the registry (castrum rejects
      // same-name/different-shape declarations), matching core semantics
      // where buckets are registry-wide.
      const cacheKey = `${name}|${keys.join(",")}`;
      let s = histSeries.get(cacheKey);
      if (s === undefined) {
        const effective = customBuckets ? sanitizeBuckets(customBuckets) : defaultBuckets;
        const id = inst.histogram(name, keys, effective);
        remember(id, name, 2, keys, effective);
        s = { id, keys };
        histSeries.set(cacheKey, s);
      }
      const { id, keys: ks } = s;
      const valsNow = (): string => ks.map((k) => labels[k] ?? "").join("\u001f");
      // Hint-addressed hot lane.
      if (hint !== undefined) {
        let v = histHintViews.get(hint);
        if (v === undefined) {
          const valsArr = ks.map((k) => labels[k] ?? "");
          v = {
            observe(value) {
              inst.record(id, valsArr, value);
            },
            get count(): number {
              return readSeries(name, keys, valsArr.join("\u001f"), 2).hist?.count ?? 0;
            },
            get sum(): number {
              return readSeries(name, keys, valsArr.join("\u001f"), 2).hist?.sum ?? 0;
            },
            get buckets(): RegistrySnapshot["histograms"][number]["buckets"] {
              return readSeries(name, keys, valsArr.join("\u001f"), 2).hist?.buckets ?? [];
            },
          };
          histHintViews.set(hint, v);
        }
        return v;
      }
      return {
        observe(value) {
          inst.record(
            id,
            ks.map((k) => labels[k] ?? ""),
            value,
          );
        },
        get count(): number {
          return readSeries(name, keys, valsNow(), 2).hist?.count ?? 0;
        },
        get sum(): number {
          return readSeries(name, keys, valsNow(), 2).hist?.sum ?? 0;
        },
        get buckets(): RegistrySnapshot["histograms"][number]["buckets"] {
          return readSeries(name, keys, valsNow(), 2).hist?.buckets ?? [];
        },
      };
    },

    renderPrometheus() {
      return inst.render();
    },

    snapshot(): RegistrySnapshot {
      return decodeMetricsSnapshot(inst.snapshot());
    },
  };
};
