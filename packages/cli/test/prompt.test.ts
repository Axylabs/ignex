/**
 * Tests for the interactive prompt toolkit — the non-TTY fallback behavior
 * (vitest runs without a TTY, so every prompt must resolve to its
 * initial/default instead of hanging).
 */

import { describe, expect, it } from "vitest";
import {
  promptConfirm,
  promptMultiSelect,
  promptPassword,
  promptSelect,
  promptText,
} from "../src/utils/prompt.js";

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
