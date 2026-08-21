/**
 * `terminal` — Bun-first display-width helpers for CLI tables.
 * In the vitest sandbox the Bun global is absent, so these fall back to
 * naive `.length` behavior; both paths must produce identical output for
 * plain ASCII.
 */

import { describe, expect, it } from "vitest";
import { padAnsi, stringWidth, truncateAnsi } from "../src/utils/terminal";

describe("stringWidth", () => {
  it("counts ASCII by length", () => {
    expect(stringWidth("GET")).toBe(3);
    expect(stringWidth("")).toBe(0);
  });
});

describe("padAnsi", () => {
  it("pads short strings to the target width", () => {
    expect(padAnsi("GET", 6)).toBe("GET   ");
    expect(padAnsi("", 2)).toBe("  ");
  });

  it("leaves equal-width strings unchanged", () => {
    expect(padAnsi("POST", 4)).toBe("POST");
  });

  it("truncates overly long strings with an ellipsis", () => {
    expect(truncateAnsi("a-very-long-path-that-exceeds-the-column", 12)).toMatch(/^.{1,11}…$/);
    expect(truncateAnsi("short", 12)).toBe("short");
    expect(padAnsi("a-very-long-path-that-exceeds-the-column", 12)).toMatch(/…$/);
  });
});
