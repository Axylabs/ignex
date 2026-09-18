/**
 * Process-level memory maintenance bridge (`flushNativeMemory`,
 * `clearNativeSchemaCache`).
 *
 * castrum owns the caches and exposes the hooks (`flushMemory`, and
 * `rust.clearSchemaCache`); `@ignex/native` only routes to them and must
 * degrade to a silent no-op whenever the module/addon is absent — importing or
 * calling these is never allowed to throw. These tests inject a fake castrum
 * module through the loader and assert the target is invoked exactly once with
 * the given args. The `IGNEX_NATIVE=off` parity path is a true no-op: the
 * loader is never consulted and no hook runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/loader", () => ({ loadCastrumModule: vi.fn() }));

import { loadCastrumModule } from "../src/loader";
import { clearNativeSchemaCache, flushNativeMemory } from "../src/memory";
import {
  type DegradationEvent,
  resetTelemetryRateLimit,
  setNativeTelemetrySink,
} from "../src/telemetry";

const loadMock = vi.mocked(loadCastrumModule);

let events: DegradationEvent[];
const originalNativeFlag = process.env.IGNEX_NATIVE;

beforeEach(() => {
  process.env.IGNEX_NATIVE = "on";
  events = [];
  resetTelemetryRateLimit();
  setNativeTelemetrySink((event) => events.push(event));
  loadMock.mockReset();
  loadMock.mockResolvedValue(null);
});

afterEach(() => {
  if (originalNativeFlag === undefined) delete process.env.IGNEX_NATIVE;
  else process.env.IGNEX_NATIVE = originalNativeFlag;
  setNativeTelemetrySink(null);
  resetTelemetryRateLimit();
  loadMock.mockReset();
});

describe("flushNativeMemory", () => {
  it("resolves without throwing when the castrum module is absent", async () => {
    await expect(flushNativeMemory()).resolves.toBeUndefined();
    await expect(flushNativeMemory({ gc: false })).resolves.toBeUndefined();
    // An expected fallback is not a degradation.
    expect(events).toEqual([]);
  });

  it("invokes castrum flushMemory exactly once with the given options", async () => {
    const flushMemory = vi.fn();
    loadMock.mockResolvedValue({ flushMemory });

    await flushNativeMemory({ gc: false });

    expect(flushMemory).toHaveBeenCalledTimes(1);
    expect(flushMemory).toHaveBeenCalledWith({ gc: false });
  });

  it("forwards an omitted options argument unchanged", async () => {
    const flushMemory = vi.fn();
    loadMock.mockResolvedValue({ flushMemory });

    await flushNativeMemory();

    expect(flushMemory).toHaveBeenCalledTimes(1);
    expect(flushMemory).toHaveBeenCalledWith(undefined);
  });

  it("never throws when the castrum loader rejects, and reports call-failed", async () => {
    loadMock.mockRejectedValue(new Error("castrum exploded"));

    await expect(flushNativeMemory()).resolves.toBeUndefined();

    expect(events.some((e) => e.kind === "call-failed" && e.op === "memory.flush")).toBe(true);
  });

  it("reports surface-missing when the module lacks flushMemory", async () => {
    loadMock.mockResolvedValue({});

    await expect(flushNativeMemory()).resolves.toBeUndefined();

    expect(events.some((e) => e.kind === "surface-missing" && e.op === "memory.flush")).toBe(true);
  });

  it("contains a synchronous hook throw and reports call-failed", async () => {
    loadMock.mockResolvedValue({
      flushMemory: () => {
        throw new Error("flush boom");
      },
    });

    await expect(flushNativeMemory()).resolves.toBeUndefined();

    const event = events.find((e) => e.kind === "call-failed" && e.op === "memory.flush");
    expect(event?.message).toBe("flush boom");
  });

  it("awaits an async hook rejection instead of leaking it", async () => {
    loadMock.mockResolvedValue({
      flushMemory: () => Promise.reject(new Error("async flush boom")),
    });

    await expect(flushNativeMemory()).resolves.toBeUndefined();

    const event = events.find((e) => e.kind === "call-failed" && e.op === "memory.flush");
    expect(event?.message).toBe("async flush boom");
  });
});

describe("clearNativeSchemaCache", () => {
  it("resolves without throwing when the castrum module is absent", async () => {
    await expect(clearNativeSchemaCache()).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("invokes rust.clearSchemaCache exactly once", async () => {
    const clearSchemaCache = vi.fn();
    loadMock.mockResolvedValue({ rust: { clearSchemaCache } });

    await clearNativeSchemaCache();

    expect(clearSchemaCache).toHaveBeenCalledTimes(1);
  });

  it("falls back to a top-level clearSchemaCache export", async () => {
    const clearSchemaCache = vi.fn();
    loadMock.mockResolvedValue({ clearSchemaCache });

    await clearNativeSchemaCache();

    expect(clearSchemaCache).toHaveBeenCalledTimes(1);
  });

  it("never throws when the castrum loader rejects, and reports call-failed", async () => {
    loadMock.mockRejectedValue(new Error("castrum exploded"));

    await expect(clearNativeSchemaCache()).resolves.toBeUndefined();

    expect(events.some((e) => e.kind === "call-failed" && e.op === "memory.schema-cache")).toBe(
      true,
    );
  });

  it("reports surface-missing when neither export exists", async () => {
    loadMock.mockResolvedValue({ rust: {} });

    await expect(clearNativeSchemaCache()).resolves.toBeUndefined();

    expect(events.some((e) => e.kind === "surface-missing" && e.op === "memory.schema-cache")).toBe(
      true,
    );
  });

  it("contains a synchronous hook throw and reports call-failed", async () => {
    loadMock.mockResolvedValue({
      rust: {
        clearSchemaCache: () => {
          throw new Error("clear boom");
        },
      },
    });

    await expect(clearNativeSchemaCache()).resolves.toBeUndefined();

    const event = events.find((e) => e.kind === "call-failed" && e.op === "memory.schema-cache");
    expect(event?.message).toBe("clear boom");
  });
});

describe("IGNEX_NATIVE=off", () => {
  it("never loads the module and never invokes a hook (true no-op)", async () => {
    const flushMemory = vi.fn();
    const clearSchemaCache = vi.fn();
    loadMock.mockResolvedValue({ flushMemory, rust: { clearSchemaCache } });
    process.env.IGNEX_NATIVE = "off";

    await expect(flushNativeMemory({ gc: false })).resolves.toBeUndefined();
    await expect(flushNativeMemory()).resolves.toBeUndefined();
    await expect(clearNativeSchemaCache()).resolves.toBeUndefined();

    expect(loadMock).not.toHaveBeenCalled();
    expect(flushMemory).not.toHaveBeenCalled();
    expect(clearSchemaCache).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
