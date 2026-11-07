/**
 * Fault-suppression sink — `onFaultSuppressed` exposes rejection-storm
 * counts to metrics/notifiers (previously only the console log line carried
 * them), with broken sinks never able to break reporting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { onFaultSuppressed, reportFault, resetFaultDedupe } from "../src/platform/fault-report";

afterEach(() => {
  resetFaultDedupe();
  vi.restoreAllMocks();
});

describe("onFaultSuppressed sink", () => {
  it("fires with the suppressed count once the window starts swallowing", () => {
    process.env.IGNEX_ERROR_DEDUPE_MS = "5000";
    const seen: Array<{ code: string; suppressed: number }> = [];
    const unsubscribe = onFaultSuppressed((fault, suppressed) => {
      seen.push({ code: fault.code, suppressed });
    });
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      // First report prints (no suppression yet); two identical ones swallow.
      reportFault(new Error("storm-surface"), { code: "IGN_TEST_STORM" });
      reportFault(new Error("storm-surface"), { code: "IGN_TEST_STORM" });
      reportFault(new Error("storm-surface"), { code: "IGN_TEST_STORM" });
      // Two suppressed reports each fired with a running count.
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen[seen.length - 1]?.suppressed).toBe(2);
    } finally {
      unsubscribe();
      delete process.env.IGNEX_ERROR_DEDUPE_MS;
    }
  });

  it("unsubscribing stops delivery", () => {
    process.env.IGNEX_ERROR_DEDUPE_MS = "5000";
    const events: number[] = [];
    const unsubscribe = onFaultSuppressed((_f, n) => events.push(n));
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      reportFault(new Error("unsub-surface"), { code: "IGN_TEST_UNSUB" });
      unsubscribe();
      reportFault(new Error("unsub-surface"), { code: "IGN_TEST_UNSUB" });
      // The first report PRINTS (nothing suppressed yet → no event); the
      // post-unsubscribe suppression is not delivered.
      expect(events.length).toBe(0);
    } finally {
      delete process.env.IGNEX_ERROR_DEDUPE_MS;
    }
  });

  it("a throwing sink never breaks reporting", () => {
    process.env.IGNEX_ERROR_DEDUPE_MS = "5000";
    const unsubscribe = onFaultSuppressed(() => {
      throw new Error("broken sink");
    });
    try {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const returned = reportFault(new Error("sink-safe"), { code: "IGN_TEST_SAFE" });
      expect(returned).toBeInstanceOf(Error);
      expect(err.mock.calls.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      delete process.env.IGNEX_ERROR_DEDUPE_MS;
    }
  });
});
