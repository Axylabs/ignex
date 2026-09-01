/**
 * Metrics registry — native-accelerated where available.
 *
 * Backed by castrum's sharded `MetricsRegistry` (counters / cumulative-bucket
 * histograms + a deterministic Prometheus render): every update crosses as
 * ONE native call with `\u001f`-joined label values, and the machine-readable
 * read path is the packed v1 snapshot dump (families first, then per-series
 * values) which {@link decodeMetricsSnapshot} turns into the same shape
 * `@ignex/core`'s `Metrics.snapshot()` produces.
 *
 * When the addon is absent, {@link createMetricsRegistryFallback} provides
 * the byte-compatible pure-TS implementation (same render format, same
 * snapshot shape, same determinism).
 */
import { type FfiMetricsSurface, getFfiMetrics } from "./ffi";
import { native } from "./runtime";

/** Options for {@link createMetricsRegistry}. */
export interface MetricsRegistryOptions {
  /** Histogram bucket upper-bounds. Default spans 1 → 10_000 (13 buckets). */
  histogramBuckets?: readonly number[];
}

/**
 * A labeled counter view. `inc` is the hot path; `value` is a COLD read
 * (decodes a fresh snapshot) intended for tests/debug/exporters.
 */
export interface RegistryCounter {
  inc(by?: number): void;
  readonly value: number;
}

/** A labeled histogram view (cumulative buckets). Reads are cold like {@link RegistryCounter.value}. */
export interface RegistryHistogram {
  observe(value: number): void;
  readonly count: number;
  readonly sum: number;
  readonly buckets: ReadonlyArray<{ le: number; count: number }>;
}

/** Decoded snapshot series (mirrors `@ignex/core`'s `MetricsSnapshot`). */
export interface RegistrySnapshot {
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  histograms: Array<{
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    buckets: Array<{ le: number; count: number }>;
  }>;
}

/** The registry surface consumed by `@ignex/core`. */
export interface MetricsRegistryLike {
  counter(name: string, labels?: Record<string, string>, hint?: string): RegistryCounter;
  histogram(
    name: string,
    labels?: Record<string, string>,
    buckets?: readonly number[],
    hint?: string,
  ): RegistryHistogram;
  /** Prometheus text exposition (includes `# TYPE` headers). */
  renderPrometheus(): string;
  /** Machine-readable snapshot (decoded v1 dump). */
  snapshot(): RegistrySnapshot;
  /** Free the native handle when bun:ffi-backed (no-op otherwise). */
  destroy?(): void;
}

const DEFAULT_BUCKETS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const sortedKeys = (labels: Record<string, string>): string[] => Object.keys(labels).sort();

// ── Packed v1 snapshot decoding ─────────────────────────────────────────────

interface FamilyMeta {
  name: string;
  kind: 0 | 1 | 2;
  keys: string[];
  buckets: number[];
  /** Live series count for this family (recomputed per snapshot/render). */
  seriesCount: number;
}

const snapshotDecoder = new TextDecoder();

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

// ── Native-backed ───────────────────────────────────────────────────────────

interface NativeRegistry {
  counter(name: string, labelKeys: string[]): number;
  histogram(name: string, labelKeys: string[], buckets: number[]): number;
  record(series: number, values: string[], amount: number): void;
  render(): string;
  snapshot(): Uint8Array;
}

/** Buckets must be finite, > 0 and ≤ 64 entries for the native engine. */
const sanitizeBuckets = (b: readonly number[]): number[] => {
  const clean = [...b].filter((x) => Number.isFinite(x) && x > 0).sort((a, z) => a - z);
  const deduped = clean.filter((x, i) => i === 0 || x !== clean[i - 1]);
  return deduped.length > 0 ? deduped.slice(0, 64) : [1];
};

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

// ── Pure-TS fallback ────────────────────────────────────────────────────────

/** Escaping parity with the Rust render (`\`, `"`, newline). */
const escapeLabelValue = (v: string): string =>
  v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Integral floats print without a decimal point (Rust Display parity). */
const fmtF64 = (v: number): string => (Number.isInteger(v) ? String(v) : String(v));

/**
 * Byte-compatible pure-TS fallback mirroring castrum's registry semantics:
 * declaration-order families, series sorted by raw label bytes within a
 * family, `# TYPE` headers interleaved per family, integral floats without
 * decimal points, and the snapshot built from the SAME in-memory state.
 *
 * State model (mirrors the Rust shards): one entry PER SERIES
 * (`familyId \0 rawJoinedValues`), so label VALUES select the accumulator;
 * the (name, sorted-keys) pair only resolves the FAMILY.
 */
export const createMetricsRegistryFallback = (
  options: MetricsRegistryOptions = {},
): MetricsRegistryLike => {
  const defaultBuckets = [...(options.histogramBuckets ?? DEFAULT_BUCKETS)];

  interface ScalarState {
    fam: number;
    keys: string[];
    vals: string;
    v: number;
  }
  interface HistState {
    fam: number;
    keys: string[];
    vals: string;
    buckets: number[];
    counts: number[];
    sum: number;
    count: number;
  }
  const scalars = new Map<string, ScalarState>();
  const hists = new Map<string, HistState>();
  const familiesMeta: FamilyMeta[] = [];
  /** (name | sortedKeys) → family id — the FAMILY resolver, not the series. */
  const famByKey = new Map<string, number>();
  /** Hint-addressed views (hot lane). */
  const counterHintViews = new Map<string, RegistryCounter>();
  const histHintViews = new Map<string, RegistryHistogram>();

  const pushFamily = (name: string, kind: 0 | 1 | 2, keys: string[], buckets: number[]): number => {
    const id = familiesMeta.length;
    familiesMeta[id] = { name, kind, keys, buckets, seriesCount: 0 };
    return id;
  };

  const labelsOf = (keys: string[], vals: string): Record<string, string> => {
    const parts = vals.length === 0 ? [] : vals.split("\u001f");
    const labels: Record<string, string> = {};
    for (let i = 0; i < keys.length; i++) labels[keys[i] as string] = parts[i] ?? "";
    return labels;
  };

  return {
    counter(name, labels = {}, hint) {
      const keys = sortedKeys(labels);
      const famKey = `${name}|${keys.join(",")}`;
      let fam = famByKey.get(famKey);
      if (fam === undefined) {
        fam = pushFamily(name, 0, keys, []);
        famByKey.set(famKey, fam);
      }
      const vals = keys.map((k) => labels[k] ?? "").join("\u001f");
      const skey = `${fam}\u0000${vals}`;
      let st = scalars.get(skey);
      if (st === undefined) {
        st = { fam, keys, vals, v: 0 };
        scalars.set(skey, st);
        (familiesMeta[fam] as FamilyMeta).seriesCount += 1;
      }
      if (hint !== undefined) {
        let vh = counterHintViews.get(hint);
        if (vh === undefined) {
          vh = {
            inc(by = 1) {
              st.v += by;
            },
            get value(): number {
              return st.v;
            },
          };
          counterHintViews.set(hint, vh);
        }
        return vh;
      }
      return {
        inc(by = 1) {
          st.v += by;
        },
        get value(): number {
          return st.v;
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
      const famKey = `${name}|${keys.join(",")}`;
      let fam = famByKey.get(famKey);
      if (fam === undefined) {
        const effective = customBuckets ? sanitizeBuckets(customBuckets) : defaultBuckets;
        fam = pushFamily(name, 2, keys, effective);
        famByKey.set(famKey, fam);
      }
      const meta = familiesMeta[fam] as FamilyMeta;
      const nB = meta.buckets.length;
      const vals = keys.map((k) => labels[k] ?? "").join("\u001f");
      const skey = `${fam}\u0000${vals}`;
      let st = hists.get(skey);
      if (st === undefined) {
        st = {
          fam,
          keys,
          vals,
          buckets: meta.buckets,
          counts: Array.from({ length: nB }, () => 0),
          sum: 0,
          count: 0,
        };
        hists.set(skey, st);
        (familiesMeta[fam] as FamilyMeta).seriesCount += 1;
      }
      // Hint-addressed hot lane: state cached per hint → arithmetic only.
      if (hint !== undefined) {
        let vh = histHintViews.get(hint);
        if (vh === undefined) {
          vh = {
            observe(value) {
              st.count += 1;
              st.sum += value;
              if (!Number.isNaN(value)) {
                let i = 0;
                while (i < nB && (meta.buckets[i] as number) < value) i++;
                for (; i < nB; i++) st.counts[i] = (st.counts[i] ?? 0) + 1;
              }
            },
            get count(): number {
              return st.count;
            },
            get sum(): number {
              return st.sum;
            },
            get buckets(): RegistrySnapshot["histograms"][number]["buckets"] {
              let cum = 0;
              return meta.buckets.map((le, i) => {
                cum += st.counts[i] ?? 0;
                return { le, count: cum };
              });
            },
          };
          histHintViews.set(hint, vh);
        }
        return vh;
      }
      return {
        observe(value) {
          st.count += 1;
          st.sum += value;
          if (!Number.isNaN(value)) {
            let i = 0;
            while (i < nB && (meta.buckets[i] as number) < value) i++;
            for (; i < nB; i++) st.counts[i] = (st.counts[i] ?? 0) + 1;
          }
        },
        get count(): number {
          return st.count;
        },
        get sum(): number {
          return st.sum;
        },
        get buckets(): RegistrySnapshot["histograms"][number]["buckets"] {
          // Fallback counts[] are already cumulative.
          let cum = 0;
          return meta.buckets.map((le, i) => {
            cum += st.counts[i] ?? 0;
            return { le, count: cum };
          });
        },
      };
    },

    snapshot() {
      // Deterministic: group by family (declaration order), then sort each
      // family's series by raw label-value bytes (the Rust sort key).
      const rows: Array<{ fam: number; keys: string[]; vals: string; kind: 0 | 1 | 2 }> = [];
      for (const [skey, st] of scalars) {
        void skey;
        rows.push({ fam: st.fam, keys: st.keys, vals: st.vals, kind: 0 });
      }
      for (const [skey, st] of hists) {
        void skey;
        rows.push({ fam: st.fam, keys: st.keys, vals: st.vals, kind: 2 });
      }
      rows.sort((a, b) => {
        if (a.fam !== b.fam) return a.fam - b.fam;
        const cmp = Buffer.from(a.vals, "utf8").compare(Buffer.from(b.vals, "utf8"));
        return cmp !== 0 ? cmp : a.keys.join(",").localeCompare(b.keys.join(","));
      });
      const counters: RegistrySnapshot["counters"] = [];
      const histograms: RegistrySnapshot["histograms"] = [];
      for (const row of rows) {
        const labels = labelsOf(row.keys, row.vals);
        if (row.kind === 2) {
          const st = hists.get(`${row.fam}\u0000${row.vals}`) as HistState;
          // Fallback counts[] are ALREADY cumulative (each observe increments
          // every qualifying bucket) — unlike the Rust dump, which stores raw
          // per-bucket counts and needs the cumulative pass in the decoder.
          const buckets = st.buckets.map((le, i) => ({
            le,
            count: st.counts[i] ?? 0,
          }));
          histograms.push({
            name: (familiesMeta[row.fam] as FamilyMeta).name,
            labels,
            count: st.count,
            sum: st.sum,
            buckets,
          });
        } else {
          const st = scalars.get(`${row.fam}\u0000${row.vals}`) as ScalarState;
          counters.push({ name: (familiesMeta[row.fam] as FamilyMeta).name, labels, value: st.v });
        }
      }
      return { counters, histograms };
    },

    renderPrometheus() {
      // Byte-parity with the Rust render: per family (declaration order), the
      // TYPE header THEN that family's series (snapshot arrays are already
      // grouped/sorted).
      const snap = this.snapshot();
      let out = "";
      let ci = 0;
      let hi = 0;
      const pairsOf = (labels: Record<string, string>): string[] =>
        Object.entries(labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
      const emit = (name: string, pairs: string[], suffix: string, value: string): string => {
        const all = suffix === "" ? pairs : [...pairs, suffix];
        const lbl = all.length > 0 ? `{${all.join(",")}}` : "";
        return `${name}${lbl} ${value}\n`;
      };
      for (const fam of familiesMeta) {
        out += `# TYPE ${fam.name} ${fam.kind === 0 ? "counter" : "histogram"}\n`;
        if (fam.kind === 0) {
          for (let i = 0; i < fam.seriesCount; i++) {
            const c = snap.counters[ci++] as RegistrySnapshot["counters"][number];
            out += emit(fam.name, pairsOf(c.labels), "", fmtF64(c.value));
          }
        } else {
          for (let i = 0; i < fam.seriesCount; i++) {
            const h = snap.histograms[hi++] as RegistrySnapshot["histograms"][number];
            const pairs = pairsOf(h.labels);
            for (const b of h.buckets) {
              out += emit(`${h.name}_bucket`, pairs, `le="${fmtF64(b.le)}"`, String(b.count));
            }
            out += emit(`${h.name}_bucket`, pairs, 'le="+Inf"', String(h.count));
            out += emit(`${h.name}_sum`, pairs, "", fmtF64(h.sum));
            out += emit(`${h.name}_count`, pairs, "", String(h.count));
          }
        }
      }
      return out;
    },
  };
};

/**
 * Create a metrics registry — native-backed when the addon is loaded, pure-TS
 * fallback otherwise. Never throws.
 */
export const createMetricsRegistry = (
  options: MetricsRegistryOptions = {},
): MetricsRegistryLike => {
  try {
    return createNativeMetricsRegistry(options);
  } catch {
    return createMetricsRegistryFallback(options);
  }
};
