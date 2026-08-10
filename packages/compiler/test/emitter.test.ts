import { describe, expect, it } from "vitest";
import { Emitter } from "../src/emitter";

describe("Emitter", () => {
  it("indents block bodies", () => {
    const e = new Emitter();
    e.line("function f() {");
    e.indent();
    e.line("return 1;");
    e.dedent();
    e.line("}");

    expect(e.toString()).toBe("function f() {\n  return 1;\n}");
  });

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

  it("supports block() with an explicit close", () => {
    const e = new Emitter();
    e.block(
      "const obj",
      () => {
        e.line("a: 1");
      },
      "};",
    );

    expect(e.toString()).toBe("const obj {\n  a: 1\n};");
  });
});
