/**
 * `ignex factory` — test-data factory generation.
 *
 * The value generator (`valueExpr`) and the emitted module (`factoryTemplate`)
 * are pure and covered here; the CLI command is a thin scaffold wrapper.
 */
import { describe, expect, it } from "vitest";
import { factoryTemplate, valueExpr } from "../src/templates/factory.js";
import { parseModelFields } from "../src/templates/model.js";

describe("valueExpr", () => {
  it("maps each field type to a randomized value expression", () => {
    expect(valueExpr("string")).toContain("field-");
    expect(valueExpr("string(format email)")).toContain("@example.com");
    expect(valueExpr("string(format uuid)")).toBe("crypto.randomUUID()");
    expect(valueExpr("integer")).toContain("Math.random");
    expect(valueExpr("number")).toContain("toFixed(2)");
    expect(valueExpr("boolean")).toContain("% 2 === 0");
    expect(valueExpr("date")).toContain("new Date(");
    expect(valueExpr("objectId")).toContain("Array.from({ length: 24 }");
    expect(valueExpr("array(integer)")).toContain("Array.from({ length: 1 +");
    expect(valueExpr("enum(admin,editor)")).toContain('"admin", "editor"');
    expect(valueExpr("any")).toContain("value-");
  });

  it("string(minN maxM) produces a fixed-minimum-length expression", () => {
    const expr = valueExpr("string(min5 max20)");
    expect(expr).toContain("length: 5 +");
  });
});

describe("factoryTemplate", () => {
  it("emits make / makeMany / seed with per-field generators", () => {
    const fields = parseModelFields(
      "email:string(format email),age:integer,role:enum(admin,editor),tags:array(string)",
    );
    const code = factoryTemplate("User", fields);
    expect(code).toContain("export function makeUser(");
    expect(code).toContain("makeManyUser");
    expect(code).toContain("seedUser");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the
    // literal `${…}` text the generated factory must contain.
    expect(code).toContain("user${Math.floor(Math.random() * 1000)}@example.com");
    expect(code).toContain('"admin", "editor"');
    expect(code).toContain("tags: Array.from({ length: 1 +");
    expect(code).toContain('db.insertMany("users"');
  });

  it("one field per line (no array-join commas)", () => {
    const fields = parseModelFields("a:string,b:integer,c:boolean");
    const code = factoryTemplate("Widget", fields);
    // Every generated field line must end with exactly one comma and no `,,`.
    expect(code).not.toContain(",,");
    expect(code.match(/\n {2}[a-z]+: /g)?.length).toBe(3);
  });

  it("reuses the raw DSL spec (format/enum/array survive)", () => {
    const fields = parseModelFields("email:string(format email),role:enum(admin,editor)");
    expect(fields[0]?.spec).toBe("string(format email)");
    expect(fields[1]?.spec).toBe("enum(admin,editor)");
    const code = factoryTemplate("User", fields);
    expect(code).toContain("@example.com");
    expect(code).toContain('["admin", "editor"]');
  });
});
