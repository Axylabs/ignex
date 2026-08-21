/**
 * Tests for the interactive prompt toolkit — rendering helpers and the
 * non-TTY fallback behavior (vitest runs without a TTY, so every prompt must
 * resolve to its initial/default instead of hanging).
 */

import { describe, expect, it } from "vitest";
import {
  parseSelectKey,
  promptConfirm,
  promptMultiSelect,
  promptPassword,
  promptSelect,
  promptText,
  renderOptionLine,
  renderSelectLines,
} from "../src/utils/prompt.js";

describe("renderOptionLine", () => {
  it("marks the active single-select option with the cursor glyph", () => {
    const line = renderOptionLine({ value: "bun" }, true, null);
    expect(line).toContain("bun");
    expect(line).toContain("›");
  });

  it("renders inactive options without the cursor", () => {
    const line = renderOptionLine({ value: "bun" }, false, null);
    expect(line).toContain("bun");
    expect(line).not.toContain("›");
  });

  it("renders hints", () => {
    const line = renderOptionLine({ value: "a", hint: "nifty" }, false, null);
    expect(line).toContain("a");
    expect(line).toContain("nifty");
  });

  it("renders checked/unchecked boxes for multi-select", () => {
    const checked = renderOptionLine({ value: "a" }, false, true);
    const unchecked = renderOptionLine({ value: "a" }, false, false);
    expect(checked).toContain("●");
    expect(unchecked).toContain("○");
    expect(checked).not.toContain("○");
  });
});

describe("renderSelectLines", () => {
  it("marks the active row and checked indexes", () => {
    const options = [{ value: "mongo" }, { value: "redis" }, { value: "nats" }];
    const lines = renderSelectLines(options, 1, [0, 2]);
    expect(lines[0]).toContain("●"); // mongo checked
    expect(lines[1]).toContain("›"); // redis active
    expect(lines[1]).toContain("○"); // redis unchecked
    expect(lines[2]).toContain("●"); // nats checked
  });
});

describe("parseSelectKey", () => {
  it("maps arrows and vim keys", () => {
    expect(parseSelectKey("\x1b[A")).toBe("up");
    expect(parseSelectKey("k")).toBe("up");
    expect(parseSelectKey("\x1b[B")).toBe("down");
    expect(parseSelectKey("j")).toBe("down");
  });

  it("maps confirm/toggle/all/cancel", () => {
    expect(parseSelectKey("\r")).toBe("confirm");
    expect(parseSelectKey("\n")).toBe("confirm");
    expect(parseSelectKey(" ")).toBe("toggle");
    expect(parseSelectKey("a")).toBe("all");
    expect(parseSelectKey("\x03")).toBe("cancel");
  });

  it("ignores unknown keys", () => {
    expect(parseSelectKey("x")).toBe("none");
  });
});

describe("non-TTY fallbacks", () => {
  it("promptText returns the initial value", async () => {
    expect(await promptText({ message: "Name", initial: "app" })).toBe("app");
    expect(await promptText({ message: "Name" })).toBe("");
  });

  it("promptSelect returns initial or the first option", async () => {
    const options = [{ value: "a" }, { value: "b" }];
    expect(await promptSelect({ message: "Pick", options, initial: "b" })).toBe("b");
    expect(await promptSelect({ message: "Pick", options })).toBe("a");
  });

  it("promptMultiSelect returns the initial selection", async () => {
    const options = [{ value: "a" }, { value: "b" }];
    expect(await promptMultiSelect({ message: "Pick", options, initial: ["a"] })).toEqual(["a"]);
    expect(await promptMultiSelect({ message: "Pick", options })).toEqual([]);
  });

  it("promptConfirm returns the initial answer", async () => {
    expect(await promptConfirm({ message: "Sure?", initial: true })).toBe(true);
    expect(await promptConfirm({ message: "Sure?" })).toBe(false);
  });

  it("promptPassword returns the initial value", async () => {
    expect(await promptPassword({ message: "Secret", initial: "pw" })).toBe("pw");
    expect(await promptPassword({ message: "Secret" })).toBe("");
  });
});
