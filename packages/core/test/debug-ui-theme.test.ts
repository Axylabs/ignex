/**
 * @fileoverview Theme resolution — stored choice wins, else OS preference.
 */
import { describe, expect, it } from "vitest";

import { resolveInitialTheme } from "../src/debug/ui/theme";

describe("resolveInitialTheme", () => {
  it("honours a stored choice over the OS", () => {
    expect(resolveInitialTheme("light", false)).toBe("light");
    expect(resolveInitialTheme("dark", true)).toBe("dark");
  });
  it("follows the OS when nothing is stored", () => {
    expect(resolveInitialTheme(null, true)).toBe("light");
    expect(resolveInitialTheme(null, false)).toBe("dark");
  });
  it("ignores junk values", () => {
    expect(resolveInitialTheme("banana", true)).toBe("light");
  });

  it("treats an empty string as unset", () => {
    expect(resolveInitialTheme("", false)).toBe("dark");
  });

  it("is case-sensitive — only the exact persisted values win", () => {
    expect(resolveInitialTheme("Light", false)).toBe("dark");
    expect(resolveInitialTheme("DARK", true)).toBe("light");
  });
});
