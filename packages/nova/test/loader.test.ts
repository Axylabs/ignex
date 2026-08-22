/**
 * Platform addon resolution tests (Phase 7):
 *   - the cdylib filename maps per-platform (.so / .dylib / .dll)
 *   - getAddonPath honors IGNEX_FFI_PATH and resolves the dev build on Linux
 */
import { describe, expect, test } from "bun:test";
import { addonCandidates, addonFilename, getAddonPath } from "../src/native/loader";

describe("addon resolution", () => {
  test("filename maps per-platform", () => {
    expect(addonFilename("linux")).toBe("libignex_ffi.so");
    expect(addonFilename("darwin")).toBe("libignex_ffi.dylib");
    expect(addonFilename("win32")).toBe("ignex_ffi.dll");
    expect(() => addonFilename("plan9")).toThrow(/unsupported platform/);
  });

  test("candidates include the platform-appropriate dev build + prebuilds layout", () => {
    const cands = addonCandidates();
    const file = addonFilename();
    expect(cands.length).toBeGreaterThanOrEqual(2);
    expect(cands[0]!.endsWith(`rust/target/release/${file}`)).toBe(true);
    expect(cands.some((c) => c.includes("prebuilds"))).toBe(true);
  });

  test("IGNEX_FFI_PATH override wins", () => {
    const prev = process.env.IGNEX_FFI_PATH;
    process.env.IGNEX_FFI_PATH = "/tmp/custom/libignex_ffi.so";
    try {
      expect(getAddonPath()).toBe("/tmp/custom/libignex_ffi.so");
    } finally {
      if (prev === undefined) delete process.env.IGNEX_FFI_PATH;
      else process.env.IGNEX_FFI_PATH = prev;
    }
  });

  test("resolves the dev build when it exists (Linux CI/repo layout)", async () => {
    const p = getAddonPath();
    expect(p.endsWith(addonFilename())).toBe(true);
    expect(await Bun.file(p).exists()).toBe(true);
  });
});
