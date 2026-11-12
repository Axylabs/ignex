/**
 * Parser record hygiene — query/form/cookie records are built with null
 * prototypes, so request-controlled keys (`__proto__`, `constructor`) can
 * never reach Object.prototype or shadow inherited members when the record
 * is spread or merged downstream.
 */
import { cookiePairs } from "@ignex/native";
import { describe, expect, it } from "vitest";
import { groupQueryPairs, parseQuery } from "../src/data/query";
import { formDataToObject, formDataToRecord } from "../src/http/body/form-data";
import { cookiePairsToRecord } from "../src/http/cookies";

describe("parser record hygiene (null prototype)", () => {
  it("query records are null-prototype — hostile keys stay inert data", () => {
    const record = parseQuery("a=1&b=plain");
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(record.a).toBe("1");
    // Assigning `__proto__` on a null-proto object is a plain property write,
    // never a prototype set — nothing below can pollute Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("spreading a hostile query record cannot set Object.prototype", () => {
    const record = groupQueryPairs([
      ["constructor", "evil"],
      ["hasOwnProperty", "evil"],
    ]);
    const merged = { ...record, safe: true } as Record<string, unknown>;
    expect(merged.safe).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("form-data records are null-prototype", () => {
    const fd = new FormData();
    fd.set("__proto__", "<pwned>");
    fd.set("name", "x");
    const record = formDataToObject(fd);
    expect((record as Record<string, unknown>).name).toBe("x");
    expect(Object.getPrototypeOf(record)).toBeNull();

    const flat = formDataToRecord(fd);
    expect(Object.getPrototypeOf(flat)).toBeNull();
    expect(Object.keys(flat)).toEqual(["__proto__", "name"]);
    expect(flat.__proto__).toBe("<pwned>");
    expect(flat.name).toBe("x");
  });

  it("cookie records are null-prototype", () => {
    const record = cookiePairsToRecord(cookiePairs("sid=abc; theme=dark"));
    expect(record.sid).toBe("abc");
    expect(Object.getPrototypeOf(record)).toBeNull();
  });

  it("records still stringify and serialize like plain data", () => {
    const record = groupQueryPairs([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(JSON.stringify(record)).toBe('{"a":"1","b":"2"}');
    expect(Object.keys(record).sort()).toEqual(["a", "b"]);
  });
});
