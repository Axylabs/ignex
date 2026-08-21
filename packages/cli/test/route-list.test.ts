/**
 * `ignex route:list` — route table rendering (pure functions).
 *
 * `routeFromFile` (filename → method+path) and `renderTable` (rows → ASCII
 * table) are pure and covered here; the command's I/O (manifest read, stdout)
 * is thin.
 */
import { describe, expect, it } from "vitest";
import { renderTable, routeFromFile } from "../src/commands/route-list.js";

describe("routeFromFile", () => {
  it("parses method + path from file-system route names", () => {
    expect(routeFromFile("index.get.ts")).toEqual({ method: "GET", path: "/" });
    expect(routeFromFile("health.get.ts")).toEqual({ method: "GET", path: "/health" });
    expect(routeFromFile("products/[id].get.ts")).toEqual({ method: "GET", path: "/products/:id" });
    expect(routeFromFile("api/gigs/[id].del.ts")).toEqual({
      method: "DELETE",
      path: "/api/gigs/:id",
    });
    expect(routeFromFile("files/[...path].post.ts")).toEqual({
      method: "POST",
      path: "/files/*path",
    });
    expect(routeFromFile("orders.post.ts")).toEqual({ method: "POST", path: "/orders" });
  });

  it("rejects non-route files", () => {
    expect(routeFromFile("README.md")).toBeNull();
    expect(routeFromFile("util.ts")).toBeNull();
  });
});

describe("renderTable", () => {
  it("renders a header and one row per route", () => {
    const rows = [
      { method: "GET", path: "/health", file: "health.get.ts", kind: "static" as const },
      {
        method: "GET",
        path: "/users/:id",
        file: "users/[id].get.ts",
        kind: "dynamic" as const,
        responseType: "json",
        hotness: 3,
      },
    ];
    const table = renderTable(rows, "/proj");
    expect(table).toContain("METHOD");
    expect(table).toContain("GET");
    expect(table).toContain("/health");
    expect(table).toContain("/users/:id");
    expect(table).toContain("dynamic");
    expect(table).toContain("json");
  });

  it("handles an empty route list", () => {
    expect(renderTable([], "/proj")).toBe("(no routes)");
  });
});
