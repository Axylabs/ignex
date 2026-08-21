/**
 * Tests for the LEAN native-stack responder route (`nativeRouteHandler`) and
 * the router `native` route kind (`createNativeIngressRouter`), synced from
 * castrum's `src/ingress/routes/native.ts` + the `native` route spec.
 *
 * The lean stack runs ONLY the plan's stages (parseQuery/parseCookies/
 * requireJsonBody/validateBody) in ONE native call — no CORS/rate-limit/
 * security/IP/metadata envelope. Skipped when the addon lacks the route
 * surface (the JS prelude remains the fallback).
 */
import {
  createNativeIngressRouter,
  createNativeRoute,
  type NativeRoutePlan,
  nativeRouteHandler,
} from "@ignex/native";
import { describe, expect, it } from "vitest";

const plan = (over: Partial<NativeRoutePlan> = {}): NativeRoutePlan => ({
  pipeline: ["parseQuery", "parseCookies"],
  schemas: {},
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 8192,
  maxCookieBytes: 8192,
  maxPairs: 0,
  ...over,
});

const bodyPlan = (): NativeRoutePlan =>
  plan({
    pipeline: ["requireJsonBody", "validateBody"],
    schemas: {
      body: new TextEncoder().encode(
        JSON.stringify({
          type: "object",
          required: ["x"],
          properties: { x: { type: "number" } },
        }),
      ),
    },
  });

const available = createNativeRoute(plan()) !== null;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("nativeRouteHandler (lean native-stack responder)", () => {
  it.skipIf(!available)("builds the 2xx from the decoded query/cookie snapshot", async () => {
    const route = createNativeRoute(plan());
    expect(route).not.toBeNull();
    if (!route) return;

    const handler = nativeRouteHandler(route, (snap) =>
      Response.json({ ok: true, query: snap.query, cookies: snap.cookies }),
    );

    const res = await handler(
      new Request("http://x/path?a=1&b=hello%20world", {
        headers: { cookie: "sid=abc; theme=dark" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      query: Record<string, string>;
      cookies: Record<string, string>;
    };
    expect(body.ok).toBe(true);
    expect(body.query).toEqual({ a: "1", b: "hello world" });
    expect(body.cookies).toEqual({ sid: "abc", theme: "dark" });
    route.destroy();
  });

  it.skipIf(!available)("rejects a non-JSON body with 400 under requireJsonBody", async () => {
    const route = createNativeRoute(bodyPlan());
    expect(route).not.toBeNull();
    if (!route) return;

    const handler = nativeRouteHandler(route, (snap) => Response.json(snap), {
      readBody: true,
    });
    const res = await handler(new Request("http://x/path", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_JSON");
    route.destroy();
  });

  it.skipIf(!available)("rejects a schema-failing body with 422 under validateBody", async () => {
    const route = createNativeRoute(bodyPlan());
    expect(route).not.toBeNull();
    if (!route) return;

    const handler = nativeRouteHandler(route, (snap) => Response.json(snap), {
      readBody: true,
    });
    const res = await handler(
      new Request("http://x/path", {
        method: "POST",
        body: enc('{"x":"str"}'),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    route.destroy();
  });

  it.skipIf(!available)("rejects an oversized body with 413", async () => {
    const route = createNativeRoute(bodyPlan());
    expect(route).not.toBeNull();
    if (!route) return;

    const handler = nativeRouteHandler(route, (snap) => Response.json(snap), {
      readBody: true,
      maxBodyBytes: 16,
    });
    const res = await handler(
      new Request("http://x/path", { method: "POST", body: enc('{"x":1,"extra":"aaaa"}') }),
    );
    expect(res.status).toBe(413);
    route.destroy();
  });
});

describe("createNativeIngressRouter native route kind", () => {
  it.skipIf(!available)("wires the lean handler for the plan's methods only", () => {
    const router = createNativeIngressRouter({
      routes: {
        "/api/native": {
          native: {
            plan: plan({ pipeline: ["parseQuery"] }),
            handler: (snap) => Response.json({ ok: true, query: snap.query }),
            methods: ["GET", "HEAD"],
          },
        },
      },
    });
    expect(router).not.toBeNull();
    if (!router) return;

    const table = router.routes["/api/native"];
    expect(typeof table?.["GET"]).toBe("function");
    expect(typeof table?.["HEAD"]).toBe("function");
    expect(table?.["POST"]).toBeUndefined();

    const res = table?.GET?.(new Request("http://x/api/native?q=1&r=2"));
    expect(res).toBeInstanceOf(Promise);
    void res;
  });
});
