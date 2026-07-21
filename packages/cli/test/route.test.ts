import { expect, test } from "vitest";
import { parseRouteInput } from "../src/utils/route.js";

test("parses static route", () => {
  const parsed = parseRouteInput("health.get");

  expect(parsed.method).toBe("get");
  expect(parsed.file).toBe("health.get.ts");
  expect(parsed.routePath).toBe("/health");
  expect(parsed.paramNames).toEqual([]);
});

test("parses dynamic route", () => {
  const parsed = parseRouteInput("products/[id].get");

  expect(parsed.method).toBe("get");
  expect(parsed.file).toBe("products/[id].get.ts");
  expect(parsed.routePath).toBe("/products/:id");
  expect(parsed.paramNames).toEqual(["id"]);
});

test("parses method flag", () => {
  const parsed = parseRouteInput("products/add", "post");

  expect(parsed.method).toBe("post");
  expect(parsed.file).toBe("products/add.post.ts");
  expect(parsed.routePath).toBe("/products/add");
});

test("normalizes delete to del", () => {
  const parsed = parseRouteInput("products/[id].delete");

  expect(parsed.method).toBe("del");
  expect(parsed.file).toBe("products/[id].del.ts");
});