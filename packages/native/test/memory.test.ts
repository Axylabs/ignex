/**
 * Process-level memory maintenance bridge (`flushNativeMemory`,
 * `clearNativeSchemaCache`).
 *
 * castrum owns the caches and exposes the hooks (`flushMemory`, and
 * `rust.clearSchemaCache`); `@ignex/native` only routes to them and must
 * degrade to a silent no-op whenever the module/addon is absent — importing or
 * calling these is never allowed to throw. These tests inject a fake castrum
 * module through the loader (the `IGNEX_NATIVE=off` parity path is mocked as
 * `null`) and assert the target is invoked exactly once with the given args.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/loader")>();
  return { ...actual, loadCastrumModule: vi.fn() };
});

import { loadCastrumModule } from "../src/loader";
import { clearNativeSchemaCache, flushNativeMemory } from "../src/memory";
import {
  type DegradationEvent,
  resetTelemetryRateLimit,
  setNativeTelemetrySink,
} from "../src/telemetry";

const loadMock = vi.mocked(loadCastrumModule);

let events: DegradationEvent[];

beforeEach(() => {
  events = [];
  resetTelemetryRateLimit();
  setNativeTelemetrySink((event) => events.push(event));
  loadMock.mockReset();
  loadMock.mockResolvedValue(null);
});

afterEach(() => {
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
});
