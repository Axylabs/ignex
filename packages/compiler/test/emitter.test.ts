import { describe, expect, it } from "vitest";
import { Emitter } from "../src/emitter";

describe("Emitter", () => {
  it("tracks helper usage for pruning", () => {
    const e = new Emitter();
    expect(e.isUsed("__wrap")).toBe(false);
    e.markUsed("__wrap");
    expect(e.isUsed("__wrap")).toBe(true);
  });

  it("tracks core imports separately", () => {
    const e = new Emitter();
    expect(e.isCoreUsed("createContext")).toBe(false);
    e.markCore("createContext");
    expect(e.isCoreUsed("createContext")).toBe(true);
    expect(e.isUsed("createContext")).toBe(false);
  });
});
