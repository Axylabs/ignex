/**
 * WebSocket route support: `*.ws.ts` files (exporting `wsHandler`) must
 * classify as `WS` routes, upgrade on GET, and wire the server's `websocket`
 * option — instead of being mis-lowered as ordinary GET HTTP routes.
 */
import { describe, expect, it } from "vitest";
import { buildAsync, parseRouteFilename } from "../src/index";
import { materializeFixture } from "./helpers";

describe("parseRouteFilename (WS routes)", () => {
  it("classifies *.ws.ts files as WS routes", () => {
    expect(parseRouteFilename("ws.ts")).toMatchObject({
      method: "WS",
      path: "/ws",
      isStatic: true,
    });
    expect(parseRouteFilename("chat.ws.ts")).toMatchObject({
      method: "WS",
      path: "/chat",
    });
    expect(parseRouteFilename("index.ws.ts")).toMatchObject({
      method: "WS",
      path: "/",
    });
  });

  it("keeps ordinary method-suffix parsing intact", () => {
    expect(parseRouteFilename("users/[id].get.ts")).toMatchObject({
      method: "GET",
      path: "/users/:id",
    });
    expect(parseRouteFilename("admin/route.DEL.ts")).toMatchObject({
      method: "DELETE",
      path: "/admin/route",
    });
  });
});

describe("compile (WS route)", () => {
  it("emits an upgrade handler, a GET route-table entry, and the websocket option", async () => {
    const layout = materializeFixture("ws");
    const result = await buildAsync({
      routesDir: layout.routesDir,
      outDir: layout.outDir,
      outFile: "server.js",
      generateTypes: false,
      generateOpenAPI: false,
      generateClient: false,
    });

    expect(result.errors).toHaveLength(0);

    // The route module's `wsHandler` is imported for the websocket option.
    expect(result.code).toContain("wsHandler as wsHandler__h0");

    // The GET route-table entry upgrades the request instead of serving a
    // normal HTTP response.
    expect(result.code).toContain('"/ws": {');
    expect(result.code).toContain("GET: __wrap(WS__h0");
    expect(result.code).toContain("server.upgrade(req)");

    // The server's websocket option is wired from the route's wsHandler.
    expect(result.code).toContain("__serveOptions.websocket ??= wsHandler__h0;");

    // It must NOT be lowered as a plain GET response route.
    expect(result.code).not.toMatch(/GET__h0/);
  });
});
