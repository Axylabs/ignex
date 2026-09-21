/**
 * @fileoverview Pure-TS metrics registry fallback — byte-compatible with the
 * castrum implementation (`IGNEX_NATIVE=off` parity: same render format,
 * same snapshot shape, same determinism).
 *
 * Extracted from the pre-split `metrics.ts` (move-only); imports the shared
 * helpers from `./shared` and family metadata from `./decode`. The native
 * twin lives in `./registry-native`.
 */

import type { FamilyMeta } from "./decode";
import { DEFAULT_BUCKETS, sanitizeBuckets, sortedKeys } from "./shared";
import type {
  MetricsRegistryLike,
  MetricsRegistryOptions,
  RegistryCounter,
  RegistryHistogram,
  RegistrySnapshot,
} from "./types";

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
