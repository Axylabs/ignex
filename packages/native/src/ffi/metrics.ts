/**
 * @fileoverview Metrics-registry C-ABI surface bind (`castrum_metrics_*`) —
 * a lazy, OPTIONAL dlopen in its own transport so a castrum build predating
 * these symbols (or a missing `bun:ffi`) yields `null` and the metrics
 * wrapper falls back to the NAPI class.
 *
 * Extracted from the pre-split `ffi.ts` (move-only).
 */
import { createRequire } from "node:module";
import { getAddonPath } from "../loader";
import type { FfiMetricsSurface } from "./types";

let metricsCached: FfiMetricsSurface | null | undefined;

/** Lazy bind of the metrics C-ABI surface (`null` when absent / pre-symbol addon). */
export const getFfiMetrics = (): FfiMetricsSurface | null => {
  if (metricsCached !== undefined) return metricsCached;
  metricsCached = null;
  if (process.env.IGNEX_NATIVE === "off") return null;

  const path = getAddonPath();
  if (!path) return null;

  type DlopenFn = (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => number | bigint | undefined>; close(): void };

  let dlopen: DlopenFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  try {
    const { symbols } = dlopen(path, {
      castrum_metrics_create: { args: [], returns: "u64" },
      castrum_metrics_counter: { args: ["u64", "cstring", "cstring"], returns: "u32" },
      castrum_metrics_gauge: { args: ["u64", "cstring", "cstring"], returns: "u32" },
      castrum_metrics_histogram: {
        args: ["u64", "cstring", "cstring", "cstring"],
        returns: "u32",
      },
      castrum_metrics_record_str: { args: ["u64", "u32", "cstring", "f64"], returns: "u8" },
      castrum_metrics_gauge_set_str: { args: ["u64", "u32", "cstring", "f64"], returns: "u8" },
      castrum_metrics_render: { args: ["u64", "ptr", "usize"], returns: "usize" },
      castrum_metrics_snapshot: { args: ["u64", "ptr", "usize"], returns: "usize" },
      castrum_metrics_destroy: { args: ["u64"], returns: "void" },
    });
    const s = symbols as Record<string, (...a: unknown[]) => number | bigint | undefined>;
    const required = [
      "castrum_metrics_create",
      "castrum_metrics_counter",
      "castrum_metrics_record_str",
      "castrum_metrics_render",
      "castrum_metrics_snapshot",
      "castrum_metrics_destroy",
    ] as const;
    if (required.some((name) => typeof s[name] !== "function")) return null;

    // Bind-time sanity: create → declare → record → render contains the value.
    const createFn = s.castrum_metrics_create as (...a: unknown[]) => number | bigint;
    const probeHandle = Number(createFn());
    try {
      const counterFn = s.castrum_metrics_counter as (...a: unknown[]) => number | bigint;
      const id = Number(counterFn(probeHandle, "__probe_total", ""));
      if (id === 0xffffffff) return null;
      const recordFn = s.castrum_metrics_record_str as (...a: unknown[]) => number | bigint;
      if (!Number(recordFn(probeHandle, id, "", 1))) return null;
      const buf = new Uint8Array(256);
      const renderFn = s.castrum_metrics_render as (...a: unknown[]) => number | bigint;
      const w = Number(renderFn(probeHandle, buf, buf.length));
      if (w === 0 || !Buffer.from(buf.buffer, 0, w).includes("__probe_total")) return null;
    } finally {
      s.castrum_metrics_destroy?.(probeHandle);
    }

    const createF = s.castrum_metrics_create as (...a: unknown[]) => number | bigint;
    const counterF = s.castrum_metrics_counter as (...a: unknown[]) => number | bigint;
    const gaugeF = s.castrum_metrics_gauge as (...a: unknown[]) => number | bigint;
    const histF = s.castrum_metrics_histogram as (...a: unknown[]) => number | bigint;
    const recordF = s.castrum_metrics_record_str as (...a: unknown[]) => number | bigint;
    const gaugeSetF = s.castrum_metrics_gauge_set_str as (...a: unknown[]) => number | bigint;
    const renderF = s.castrum_metrics_render as (...a: unknown[]) => number | bigint;
    const snapshotF = s.castrum_metrics_snapshot as (...a: unknown[]) => number | bigint;
    const destroyF = s.castrum_metrics_destroy as (h: number) => void;
    metricsCached = {
      metricsCreate: () => Number(createF()),
      metricsCounter: (h, name, keys) => Number(counterF(h, name, keys)),
      metricsGauge: (h, name, keys) => Number(gaugeF(h, name, keys)),
      metricsHistogram: (h, name, keys, buckets) => Number(histF(h, name, keys, buckets)),
      metricsRecordStr: (h, series, values, amount) =>
        Number(recordF(h, series, values, amount)) === 1,
      metricsGaugeSetStr: (h, series, values, v) => Number(gaugeSetF(h, series, values, v)) === 1,
      metricsRender: (h, out) => Number(renderF(h, out, out.length)),
      metricsSnapshot: (h, out) => Number(snapshotF(h, out, out.length)),
      metricsRecordBatch: (h, packed) => {
        const f = s.castrum_metrics_record_batch as ((...a: unknown[]) => number) | undefined;
        return f ? Number(f(h, packed, packed.length)) === 1 : false;
      },
      metricsDestroy: (h) => {
        destroyF(h);
      },
    };
    return metricsCached;
  } catch {
    return null;
  }
};
