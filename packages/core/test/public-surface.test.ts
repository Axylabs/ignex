/**
 * @fileoverview The `@ignex/core` root surface is a contract. The debug /
 * observatory toolkit is deliberately served only from the `@ignex/core/debug`
 * subpath (D-015) — a future `export *` must not quietly pull ~50 debug
 * primitives (and their module graph) back into the root entry that every
 * consumer imports.
 *
 * Types are erased at runtime, so only values can be asserted here.
 */

import { describe, expect, it } from "vitest";
import * as debugSubpath from "../src/debug/index";
import * as root from "../src/index";

/** Values that must live on the `@ignex/core/debug` subpath only. */
const DEBUG_ONLY = [
  "ClientRegistry",
  "MetricsRegistry",
  "NatsEventTracker",
  "ObservatoryDb",
  "SystemProfiler",
  "TraceStore",
  "currentTrace",
  "debugLog",
  "debugQuery",
  "debugSpan",
  "installLogStore",
  "isTracingEnabled",
  "setTracingEnabled",
] as const;

describe("@ignex/core public surface", () => {
  it("does not publish the debug/observatory toolkit from the root entry", () => {
    for (const name of DEBUG_ONLY) {
      expect(name in root, `${name} leaked into @ignex/core`).toBe(false);
    }
  });

  it("publishes the debug/observatory toolkit from @ignex/core/debug", () => {
    for (const name of DEBUG_ONLY) {
      expect(name in debugSubpath, `${name} missing from @ignex/core/debug`).toBe(true);
    }
  });

  it("still publishes the runtime domains from the root entry", () => {
    for (const name of ["createApp", "HTTPError", "NotFoundError", "session", "openapi"]) {
      expect(name in root, `${name} missing from @ignex/core`).toBe(true);
    }
  });
});
