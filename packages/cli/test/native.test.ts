/**
 * Tests for the native-status helper — the label formatting is pure, and the
 * lazy resolver must always degrade to a well-shaped status object.
 */

import { describe, expect, it } from "vitest";
import { type NativeStatus, nativeLabel, nativeStatus } from "../src/utils/native.js";

describe("nativeLabel", () => {
  it("labels an available native backend", () => {
    const status: NativeStatus = { available: true, backend: "castrum" };
    expect(nativeLabel(status)).toBe("native (castrum)");
  });

  it("labels the pure-TS fallback", () => {
    const status: NativeStatus = { available: false, backend: "js" };
    expect(nativeLabel(status)).toBe("off (pure-TS fallback)");
  });
});

describe("nativeStatus", () => {
  it("resolves to a well-shaped status (never throws)", async () => {
    const status = await nativeStatus();
    expect(typeof status.available).toBe("boolean");
    expect(typeof status.backend).toBe("string");
  });

  it("returns a stable cached result across calls", async () => {
    const first = await nativeStatus();
    const second = await nativeStatus();
    expect(second).toBe(first);
  });
});
