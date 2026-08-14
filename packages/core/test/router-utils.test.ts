/**
 * @fileoverview Pure router utilities (`http/router-utils.ts`): path → regex
 * compilation and Bun handler-argument extraction.
 */

import { describe, expect, it } from "vitest";
import { extractParams, extractServer, pathToRegex } from "../src/http/router-utils";

const serverLike = { requestIP: () => ({ address: "127.0.0.1" }), stop: () => {}, fetch: () => {} };

describe("pathToRegex", () => {
  it("anchors a static path with no captures", () => {
    const { re, keys } = pathToRegex("/api/users");
    expect(keys).toEqual([]);
    expect(re.test("/api/users")).toBe(true);
    expect(re.test("/api/users/1")).toBe(false);
    expect(re.test("/api/users-extra")).toBe(false);
  });

  it("captures a single :param segment", () => {
    const { re, keys } = pathToRegex("/api/users/:id");
    expect(keys).toEqual(["id"]);
    expect(re.exec("/api/users/42")?.[1]).toBe("42");
    expect(re.test("/api/users/")).toBe(false);
  });

  it("captures multiple named params in order", () => {
    const { re, keys } = pathToRegex("/a/:x/b/:y");
    expect(keys).toEqual(["x", "y"]);
    const m = re.exec("/a/1/b/2");
    expect(m?.[1]).toBe("1");
    expect(m?.[2]).toBe("2");
  });

  it('captures a trailing * catch-all as "*"', () => {
    const { re, keys } = pathToRegex("/files/*");
    expect(keys).toEqual(["*"]);
    expect(re.exec("/files/a/b.txt")?.[1]).toBe("a/b.txt");
    expect(re.test("/files")).toBe(false);
  });

  it("escapes literal regex metacharacters in static segments", () => {
    const { re } = pathToRegex("/docs/v1.0/index.html");
    expect(re.test("/docs/v1.0/index.html")).toBe(true);
    expect(re.test("/docs/v1X0/indexYhtml")).toBe(false);
  });
});

describe("extractParams", () => {
  it("prefers req.params when present", () => {
    const req = new Request("http://localhost/");
    expect(extractParams(req, { id: "9" }, serverLike)).toEqual({ id: "9" });
    expect(extractParams(req, serverLike, { id: "9" })).toEqual({ id: "9" });
  });

  it("reads params from the second/third non-server argument", () => {
    const req = new Request("http://localhost/");
    expect(extractParams(req, { id: "1" })).toEqual({ id: "1" });
    expect(extractParams(req, undefined, { id: "2" })).toEqual({ id: "2" });
  });

  it("never treats a server-like argument as params", () => {
    const req = new Request("http://localhost/");
    expect(extractParams(req, serverLike, serverLike)).toBeUndefined();
    expect(extractParams(req, serverLike)).toBeUndefined();
  });

  it("returns undefined when no params are present", () => {
    const req = new Request("http://localhost/");
    expect(extractParams(req)).toBeUndefined();
    expect(extractParams(req, undefined, undefined)).toBeUndefined();
  });
});

describe("extractServer", () => {
  it("resolves a server-like first or second argument", () => {
    expect(extractServer(serverLike, undefined)).toBe(serverLike);
    expect(extractServer(undefined, serverLike)).toBe(serverLike);
  });

  it("ignores non-server arguments", () => {
    expect(extractServer({ id: "1" }, undefined)).toBeUndefined();
    expect(extractServer(undefined, "bun")).toBeUndefined();
    expect(extractServer()).toBeUndefined();
  });
});
