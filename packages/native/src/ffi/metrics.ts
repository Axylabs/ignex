/**
 * @fileoverview Metrics-registry adapter over castrum's shared native bridge.
 */

import { getNativeBridge } from "../loader";
import type { FfiMetricsSurface } from "./types";

let cached: FfiMetricsSurface | null | undefined;

/** Lazy access to the metrics C-ABI surface (`null` when unavailable). */
export const getFfiMetrics = (): FfiMetricsSurface | null => {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.env.IGNEX_NATIVE === "off") return cached;

  const ffi = getNativeBridge()?.getFfi();
  if (!ffi) return cached;
  cached = {
    metricsCreate: () => ffi.metricsCreate(),
    metricsCounter: (handle, name, keys) => ffi.metricsCounter(handle, name, keys),
    metricsGauge: (handle, name, keys) => ffi.metricsGauge(handle, name, keys),
    metricsHistogram: (handle, name, keys, buckets) =>
      ffi.metricsHistogram(handle, name, keys, buckets),
    metricsRecordStr: (handle, series, values, amount) =>
      ffi.metricsRecordStr(handle, series, values, amount),
    metricsGaugeSetStr: (handle, series, values, value) =>
      ffi.metricsGaugeSetStr(handle, series, values, value),
    metricsRender: (handle, out) => ffi.metricsRender(handle, out),
    metricsSnapshot: (handle, out) => ffi.metricsSnapshot(handle, out),
    metricsRecordBatch: (handle, packed) => ffi.metricsRecordBatch(handle, packed),
    metricsDestroy: (handle) => ffi.metricsDestroy(handle),
  };
  return cached;
};
