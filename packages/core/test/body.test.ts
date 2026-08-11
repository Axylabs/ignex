/**
 * Body parsing tests.
 *
 * The split of `http/body.ts` into `http/body/` made the pure helpers
 * (conversion, size, limits, form-data) directly unit-testable. This file
 * covers those helpers, cross-kind round-trips through `createLazyBody`, and
 * property-based round-trips over generated data (`@ignus/test-utils`).
 */

import { arbJsonValue, arbQueryPair } from "@ignus/test-utils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { convertBody } from "../src/http/body/conversion.js";
import { formDataToObject, formDataToRecord } from "../src/http/body/form-data.js";
import { BodyParseError, createLazyBody } from "../src/http/body/index.js";
import { resolveLimits } from "../src/http/body/limits.js";
import {
  assertContentLength,
  assertParsedSize,
  measureParsedSize,
  textByteLength,
} from "../src/http/body/size.js";

const jsonReq = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://x/", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });

const urlEncodedReq = (body: string) =>
  new Request("http://x/", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });

describe("body pure helpers", () => {
  it("resolveLimits fills every option with its default", () => {
    const limits = resolveLimits({ maxJsonBytes: 5 });
    expect(limits.maxJsonBytes).toBe(5);
    expect(limits.maxTextBytes).toBe(2 * 1024 * 1024);
    expect(limits.maxFormBytes).toBe(2 * 1024 * 1024);
    expect(limits.maxFileBytes).toBe(20 * 1024 * 1024);
  });

  it("textByteLength counts UTF-8 bytes including multi-byte", () => {
    expect(textByteLength("")).toBe(0);
    expect(textByteLength("abc")).toBe(3);
    expect(textByteLength("héllo")).toBe(6);
    expect(textByteLength("日本語")).toBe(9);
  });

  it("measureParsedSize handles every supported kind", () => {
    expect(measureParsedSize("text", "abc")).toBe(3);
    expect(measureParsedSize("json", { a: 1 })).toBeGreaterThan(0);
    expect(measureParsedSize("arrayBuffer", new TextEncoder().encode("abcd").buffer)).toBe(4);
    expect(measureParsedSize("blob", new Blob(["xyz"]))).toBe(3);
    const fd = new FormData();
    fd.append("k", "hello");
    expect(measureParsedSize("formData", fd)).toBe(5);
  });

  it("assertContentLength throws 413 only when over the limit", () => {
    const req = new Request("http://x/", { headers: { "content-length": "100" } });
    expect(() => assertContentLength(req, 50)).toThrow(BodyParseError);
    expect(() => assertContentLength(req, 50)).toThrow(/413|Payload too large/);
    expect(() => assertContentLength(req, 200)).not.toThrow();
    expect(() => assertContentLength(req, undefined)).not.toThrow();
  });

  it("assertParsedSize throws 413 over the limit and passes under it", () => {
    expect(() => assertParsedSize("text", "hello", 4)).toThrow(BodyParseError);
    expect(() => assertParsedSize("text", "hi", 4)).not.toThrow();
  });

  it("convertBody json → text → arrayBuffer → blob", () => {
    const state = { kind: "json" as const, value: { a: 1 } };
    const text = convertBody(state, "text");
    expect(JSON.parse(text as string)).toEqual({ a: 1 });
    const buf = convertBody(state, "arrayBuffer") as ArrayBuffer;
    expect(new TextDecoder().decode(buf)).toBe(text);
    expect(convertBody(state, "blob")).toBeInstanceOf(Blob);
    expect(convertBody(state, "json")).toEqual({ a: 1 });
  });

  it("convertBody text → formData parses urlencoded", () => {
    const fd = convertBody({ kind: "text", value: "a=1&b=2" }, "formData");
    expect(fd).toBeInstanceOf(FormData);
    expect(formDataToRecord(fd as FormData)).toEqual({ a: "1", b: "2" });
  });

  it("convertBody formData → text serializes urlencoded", () => {
    const fd = new FormData();
    fd.append("a", "1");
    fd.append("b", "two words");
    const text = convertBody({ kind: "formData", value: fd }, "text") as string;
    expect(new URLSearchParams(text).get("a")).toBe("1");
    expect(new URLSearchParams(text).get("b")).toBe("two words");
  });

  it("convertBody throws 409 for impossible conversions", () => {
    const fd = new FormData();
    fd.append("a", "1");

    const capture = (fn: () => unknown): BodyParseError => {
      try {
        fn();
      } catch (err) {
        return err as BodyParseError;
      }
      throw new Error("expected convertBody to throw");
    };

    const formToJson = capture(() => convertBody({ kind: "formData", value: fd }, "json"));
    expect(formToJson).toBeInstanceOf(BodyParseError);
    expect(formToJson.status).toBe(409);

    const blobToJson = capture(() => convertBody({ kind: "blob", value: new Blob() }, "json"));
    expect(blobToJson).toBeInstanceOf(BodyParseError);
    expect(blobToJson.status).toBe(409);
  });

  it("formDataToObject accumulates duplicate keys into arrays", () => {
    const fd = new FormData();
    fd.append("a", "1");
    fd.append("a", "2");
    fd.append("b", "3");
    expect(formDataToObject(fd)).toEqual({ a: ["1", "2"], b: "3" });
  });
});

describe("createLazyBody round-trips", () => {
  it("json round-trips through every convertible kind", async () => {
    const body = createLazyBody(jsonReq('{"a":1}'));
    const json = await body.json();
    const text = await body.text();
    const buf = await body.arrayBuffer();
    const blob = await body.blob();
    expect(json).toEqual({ a: 1 });
    expect(JSON.parse(text)).toEqual(json);
    expect(new TextDecoder().decode(buf)).toBe(text);
    expect(blob.size).toBe(new TextEncoder().encode(text).byteLength);
  });

  it("urlencoded form parses into a record (last value wins)", async () => {
    const body = createLazyBody(urlEncodedReq("a=1&a=2&b=x"));
    expect(await body.form()).toEqual({ a: "2", b: "x" });
  });

  it("multipart with a file exposes file helpers", async () => {
    const fd = new FormData();
    fd.append("name", "ada");
    fd.append("avatar", new File(["bytes"], "a.png", { type: "image/png" }));
    const req = new Request("http://x/", { method: "POST", body: fd });
    const body = createLazyBody(req);
    expect(await body.form()).toEqual({ name: "ada", avatar: "a.png" });
    expect(await body.multipart()).toEqual({
      name: "ada",
      avatar: expect.any(File),
    });
    expect((await body.file("avatar"))?.name).toBe("a.png");
    expect(await body.file("missing")).toBeNull();
    expect(await body.files("avatar")).toHaveLength(1);
    expect(await body.files()).toHaveLength(1);
  });

  it("GET/HEAD/OPTIONS yield no body; unknown content type falls back to bytes", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const body = createLazyBody(new Request("http://x/", { method }));
      expect(await body()).toBeUndefined();
    }
    const raw = createLazyBody(new Request("http://x/", { method: "POST", body: "abc" }));
    expect(new TextDecoder().decode(await raw.arrayBuffer())).toBe("abc");
  });

  it("rejects a second incompatible parse with 409", async () => {
    const body = createLazyBody(urlEncodedReq("a=1"));
    await body.formData();
    await expect(body.json()).rejects.toMatchObject({ status: 409 });
  });

  it("enforces the per-file size limit", async () => {
    const fd = new FormData();
    fd.append("f", new File([new Uint8Array(100)], "f.bin"));
    const req = new Request("http://x/", { method: "POST", body: fd });
    const body = createLazyBody(req, { maxFileBytes: 10 });
    await expect(body.file("f")).rejects.toMatchObject({ status: 413 });
  });
});

describe("body property round-trips", () => {
  it("JSON round-trips any arbitrary JSON value and tracks consumption", async () => {
    await fc.assert(
      // `""` serializes to an empty body (JSON.parse("") throws → 400), so it
      // is tested explicitly below rather than here.
      fc.asyncProperty(
        arbJsonValue.filter((v) => v !== ""),
        async (value) => {
          const serialized = JSON.stringify(value);
          // JSON cannot represent e.g. -0 (serializes as 0), so the invariant is
          // that the framework round-trips exactly what JSON can represent.
          const normalized = JSON.parse(serialized);
          const body = createLazyBody(jsonReq(serialized));
          expect(await body.json()).toEqual(normalized);
          expect(body.consumed).toBe(true);
          expect(JSON.parse(await body.text())).toEqual(normalized);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects an empty JSON body with 400", async () => {
    const body = createLazyBody(jsonReq(""));
    await expect(body.json()).rejects.toMatchObject({ status: 400 });
  });

  it("urlencoded form round-trips generated pairs (last value wins)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbQueryPair, { maxLength: 8 }), async (pairs) => {
        const qs = pairs
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const body = createLazyBody(urlEncodedReq(qs));
        const expected: Record<string, string> = {};
        for (const [k, v] of pairs) expected[k] = v;
        expect(await body.form()).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("measureParsedSize('text') agrees with textByteLength", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 128 }), (s) => {
        expect(measureParsedSize("text", s)).toBe(textByteLength(s));
      }),
      { numRuns: 100 },
    );
  });
});
