/**
 * @fileoverview Metrics registry barrel — the `createMetricsRegistry`
 * dispatcher plus the exact 9-name surface `@ignex/native`'s entry pulls
 * from `./metrics`.
 *
 * Replaces the pre-split `metrics.ts` (move-only); implementations live in
 * `./types`, `./decode`, `./shared`, `./registry-native` and
 * `./registry-fallback`.
 */

import { createMetricsRegistryFallback } from "./registry-fallback";
import { createNativeMetricsRegistry } from "./registry-native";
import type { MetricsRegistryLike, MetricsRegistryOptions } from "./types";

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

export { decodeMetricsSnapshot } from "./decode";
export { createMetricsRegistryFallback } from "./registry-fallback";
export { createNativeMetricsRegistry } from "./registry-native";
export type {
  MetricsRegistryLike,
  MetricsRegistryOptions,
  RegistryCounter,
  RegistryHistogram,
  RegistrySnapshot,
} from "./types";
