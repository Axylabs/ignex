/**
 * Deterministic tests for size-bucketed adaptive native/JS execution.
 */
import { describe, expect, it, vi } from "vitest";
import { createAdaptiveExecutor } from "../src/adaptive";

describe("createAdaptiveExecutor", () => {
  it("keeps cold-start size preferences separate and avoids native when unavailable", () => {
    const native = vi.fn(() => "native");
    const js = vi.fn(() => "js");
    const executor = createAdaptiveExecutor({
      sizeBuckets: [511],
      initialImpl: (bytes) => (bytes >= 512 ? "castrum" : "js"),
      nativeAvailable: () => false,
      sampleEvery: 2,
    });

    expect(executor.execute(20, native, js)).toBe("js");
    expect(executor.execute(1024, native, js)).toBe("js");
    expect(executor.execute(20, native, js)).toBe("js");
    expect(native).not.toHaveBeenCalled();
    expect(executor.snapshot().map((bucket) => bucket.impl)).toEqual(["js", "castrum"]);
  });

  it("reads the clock only on sampled calls", () => {
    const now = 0;
    const nowNs = vi.fn(() => now);
    const executor = createAdaptiveExecutor({
      initialImpl: "js",
      nativeAvailable: () => false,
      sampleEvery: 3,
      nowNs,
    });
    const js = () => "ok";
    const native = () => "unused";

    executor.execute(1, native, js);
    executor.execute(1, native, js);
    expect(nowNs).not.toHaveBeenCalled();
    executor.execute(1, native, js);
    expect(nowNs).toHaveBeenCalledTimes(2);
  });

  it("learns that native is faster for large payloads without changing small payloads", () => {
    let now = 0;
    let nativeNs = 100;
    const executor = createAdaptiveExecutor({
      sizeBuckets: [511],
      initialImpl: (bytes) => (bytes >= 512 ? "castrum" : "js"),
      sampleEvery: 2,
      minSamples: 2,
      exploreEvery: 2,
      ewmaAlpha: 1,
      nowNs: () => now,
    });
    const native = () => {
      now += nativeNs;
      return "native";
    };
    const js = () => {
      now += 1000;
      return "js";
    };

    for (let i = 0; i < 8; i++) executor.execute(1024, native, js);
    expect(executor.snapshot()[1]).toMatchObject({
      impl: "castrum",
      nativeSamples: 2,
      jsSamples: 2,
      nativeNs: 100,
      jsNs: 1000,
    });

    executor.execute(10, native, js);
    expect(executor.snapshot()[0]?.impl).toBe("js");

    nativeNs = 5000;
    executor.execute(1024, native, js);
    executor.execute(1024, native, js);
    expect(executor.snapshot()[1]?.impl).toBe("js");
  });

  it("holds the current preference inside the hysteresis band", () => {
    let now = 0;
    const executor = createAdaptiveExecutor({
      initialImpl: "js",
      sampleEvery: 1,
      minSamples: 2,
      exploreEvery: 2,
      ewmaAlpha: 1,
      hysteresis: 0.1,
      nowNs: () => now,
    });
    const native = () => {
      now += 920;
    };
    const js = () => {
      now += 1000;
    };

    for (let i = 0; i < 8; i++) executor.execute(10, native, js);
    expect(executor.snapshot()[0]).toMatchObject({ impl: "js", nativeNs: 920, jsNs: 1000 });
  });

  it("records a sampled throwing call and preserves the exception", () => {
    let now = 0;
    const executor = createAdaptiveExecutor({
      initialImpl: "castrum",
      sampleEvery: 2,
      minSamples: 1,
      nowNs: () => now,
    });
    const failure = new Error("native failed");
    const native = () => {
      now += 50;
      throw failure;
    };
    const js = () => {
      now += 100;
      return "fallback";
    };

    expect(() => executor.execute(10, native, js)).toThrow(failure);
    expect(executor.execute(10, native, js)).toBe("fallback");
    expect(() => executor.execute(10, native, js)).toThrow(failure);
    expect(() => executor.execute(10, native, js)).toThrow(failure);
    expect(executor.snapshot()[0]?.nativeNs).toBe(50);
  });

  it("can disable learning while retaining the initial size decision", () => {
    const executor = createAdaptiveExecutor({
      enabled: false,
      sizeBuckets: [10],
      initialImpl: (bytes) => (bytes > 10 ? "castrum" : "js"),
      sampleEvery: 1,
    });
    const native = () => "native";
    const js = () => "js";

    expect(executor.execute(10, native, js)).toBe("js");
    expect(executor.execute(11, native, js)).toBe("native");
    expect(
      executor.snapshot().every((bucket) => bucket.nativeSamples + bucket.jsSamples === 0),
    ).toBe(true);
  });
});
