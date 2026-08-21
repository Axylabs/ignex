/**
 * `cron6` — the second-precision (6-field) cron matcher used by
 * `createScheduler` as the in-process fallback for legacy sub-minute
 * expressions, and the transport-classification helper `resolveTransportKind`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { nextTick6, parseCronField, validateCron6 } from "../src/platform/cron6";
import { resolveTransportKind } from "../src/platform/scheduler";

/**
 * The vitest node sandbox does not expose the `Bun` global. `resolveTransportKind`
 * delegates 5-field validation to `Bun.cron.parse` when available; install a
 * minimal stub that mirrors its accept/reject behavior for the test vectors.
 */
beforeAll(() => {
  (globalThis as unknown as { Bun?: unknown }).Bun ??= {
    cron: {
      parse: (expression: string): Date => {
        const parts = expression.trim().split(/\s+/);
        if (parts.length === 1 && parts[0].startsWith("@")) {
          if (parts[0] === "@bogus") throw new Error(`unknown named schedule: ${parts[0]}`);
          return new Date();
        }
        if (parts.length !== 5) throw new Error(`invalid cron expression: ${expression}`);
        const ranges = [
          [0, 59],
          [0, 23],
          [1, 31],
          [1, 12],
          [0, 7],
        ];
        for (let i = 0; i < parts.length; i++) {
          const value = Number(parts[i]);
          if (Number.isInteger(value) && (value < ranges[i][0] || value > ranges[i][1])) {
            throw new Error(`out of range: ${parts[i]}`);
          }
        }
        return new Date();
      },
    },
  };
});

/** Build a local-time Date. */
const at = (y: number, mo: number, d: number, h: number, mi: number, s: number): Date =>
  new Date(y, mo - 1, d, h, mi, s, 0);

describe("parseCronField", () => {
  it("returns null for a bare star", () => {
    expect(parseCronField("*", 0, 59)).toBeNull();
    expect(parseCronField("0-59", 0, 59)).not.toBeNull();
  });

  it("parses values, ranges and steps", () => {
    expect(parseCronField("5", 0, 59)).toEqual(new Set([5]));
    expect(parseCronField("1-3", 0, 59)).toEqual(new Set([1, 2, 3]));
    expect(parseCronField("*/15", 0, 59)).toEqual(new Set([0, 15, 30, 45]));
    expect(parseCronField("1,7,13", 0, 59)).toEqual(new Set([1, 7, 13]));
    expect(parseCronField("10-20/5", 0, 59)).toEqual(new Set([10, 15, 20]));
  });

  it("throws on out-of-range or malformed tokens", () => {
    expect(() => parseCronField("60", 0, 59)).toThrow();
    expect(() => parseCronField("a", 0, 59)).toThrow();
    expect(() => parseCronField("5-1", 0, 59)).toThrow();
    expect(() => parseCronField("", 0, 59)).toThrow();
  });
});

describe("nextTick6", () => {
  it("fires every second for * * * * * *", () => {
    const from = at(2026, 8, 21, 12, 0, 30);
    const next = nextTick6("* * * * * *", from);
    expect(next.getTime()).toBe(from.getTime() + 1000);
  });

  it("fires every 5 seconds aligned to the step", () => {
    const from = at(2026, 8, 21, 12, 0, 7);
    const next = nextTick6("*/5 * * * * *", from);
    expect(next.getSeconds()).toBe(10);
    expect(next.getMinutes()).toBe(0);
  });

  it("rolls over minute/hour/day/month boundaries", () => {
    expect(nextTick6("0 59 23 31 12 *", at(2026, 12, 31, 23, 58, 30)).getTime()).toBe(
      at(2026, 12, 31, 23, 59, 0).getTime(),
    );
    // Cross into the next year.
    expect(nextTick6("0 0 0 1 1 *", at(2026, 12, 31, 23, 59, 30)).getFullYear()).toBe(2027);
  });

  it("implements the POSIX dom/dow OR rule", () => {
    // dom=1, dow=Fri(5): a day matching EITHER is a hit. 2026-08-01 is a
    // Saturday (dom 1 ✓), so the next hit after that is dom=1 again… but a
    // Friday in between (2026-08-07) also matches via dow.
    const from = at(2026, 8, 1, 0, 0, 0);
    const next = nextTick6("0 0 0 1 * 5", from);
    // 2026-08-01 was a Saturday; the OR rule makes Friday 2026-08-07 the next hit.
    expect(next.getDate()).toBe(7);
    expect(next.getDay()).toBe(5);
  });

  it("skips non-matching seconds for fixed-second expressions", () => {
    const from = at(2026, 8, 21, 12, 0, 3);
    const next = nextTick6("15 * * * * *", from);
    expect(next.getSeconds()).toBe(15);
    expect(next.getMinutes()).toBe(0);
  });

  it("validates malformed expressions", () => {
    expect(() => nextTick6("not a cron", new Date())).toThrow();
    expect(() => nextTick6("0 0 0 30 2 *", new Date())).toThrow(/5 years/); // Feb 30
  });
});

describe("validateCron6", () => {
  it("accepts 6 fields and rejects wrong field counts", () => {
    expect(() => validateCron6("*/5 * * * * *")).not.toThrow();
    expect(() => validateCron6("* * * * *")).toThrow();
    expect(() => validateCron6("* * * * * * *")).toThrow();
  });
});

describe("resolveTransportKind", () => {
  it("routes 5-field and named expressions to Bun.cron", () => {
    expect(resolveTransportKind("0 9 * * *")).toBe("bun");
    expect(resolveTransportKind("*/5 * * * *")).toBe("bun");
    expect(resolveTransportKind("@daily")).toBe("bun");
    expect(resolveTransportKind("@hourly")).toBe("bun");
  });

  it("routes 6-field expressions to the in-process matcher", () => {
    expect(resolveTransportKind("* * * * * *")).toBe("matcher");
    expect(resolveTransportKind("*/5 * * * * *")).toBe("matcher");
  });

  it("throws on invalid or ambiguous expressions", () => {
    expect(() => resolveTransportKind("not-a-cron")).toThrow();
    expect(() => resolveTransportKind("0 9")).toThrow();
    expect(() => resolveTransportKind("60 * * * *")).toThrow();
    expect(() => resolveTransportKind("@bogus")).toThrow();
  });
});
