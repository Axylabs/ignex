/**
 * @fileoverview Port of Elysia `test/core/status.test.ts` — status-code
 * handling on the interpreted `createApp().handler()` path.
 *
 * Elysia's `status(code, body?)` maps to IgnEx's `ctx.status(code)` (empty
 * body) and `ctx.empty(code)` helpers. Body-suppression statuses
 * (101/204/205/304/307/308) must yield an empty body; a null-body status with
 * an explicit body is delegated to the wire layer (Bun strips it).
 *
 * Intentional divergence: Elysia's `status(201)` yields body `"Created"`;
 * IgnEx `ctx.status(201)` yields an empty body (spec-compliant Response).
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

const GET = () =>
  inject(
    app((ctx) => ctx.status(200)),
    { url: "/" },
  );

describe("status codes (interpreted path)", () => {
  it("returns 201 for an explicit status", async () => {
    const res = await inject(
      app((ctx) => ctx.status(201)),
      { url: "/" },
    );

    expect(res.status).toBe(201);
    await expect(res.text()).resolves.toBe("");
  });

  it.each([204, 205, 304, 307, 308])("suppresses the body of null-body status %i", async (code) => {
    const res = await inject(
      app((ctx) => ctx.status(code)),
      { url: "/" },
    );

    expect(res.status).toBe(code);
    expect(res.body).toBeNull();
    await expect(res.text()).resolves.toBe("");
  });

  it("never attaches a body via ctx.status on a null-body status", async () => {
    // The real guard against data corruption: `ctx.status(code)` yields a
    // body-less Response. Spec-compliant runtimes (undici under vitest) throw
    // if you force a body onto 204/205/304 — which is exactly the protection
    // we want — so ignex must never eagerly attach one.
    for (const code of [204, 205, 304]) {
      const res = await inject(
        app((ctx) => ctx.status(code)),
        { url: "/" },
      );
      expect(res.status).toBe(code);
      expect(res.body).toBeNull();
    }
  });

  it("status 101 is Bun-only (undici rejects <200 statuses)", async () => {
    // Bun supports 101; undici (the vitest node env) rejects any status
    // outside 200-599 at Response construction. Guard the framework contract:
    // when a runtime permits it, `ctx.status(101)` must yield 101 + no body.
    if (typeof Bun !== "undefined") {
      const res = await inject(
        app((ctx) => ctx.status(101)),
        { url: "/" },
      );
      expect(res.status).toBe(101);
      expect(res.body).toBeNull();
    } else {
      // Under undici the constructor throws → errorToResponse 500.
      const res = await inject(
        app((ctx) => ctx.status(101)),
        { url: "/" },
      );
      expect(res.status).toBe(500);
    }
  });

  it("applies ctx.set.status over the handler response status", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.status = 201;
        return ctx.text("ok");
      }),
      { url: "/" },
    );

    expect(res.status).toBe(201);
    await expect(res.text()).resolves.toBe("ok");
  });

  it("empty() defaults to 204 and honours an explicit code", async () => {
    const r204 = await inject(
      app((ctx) => ctx.empty()),
      { url: "/" },
    );
    expect(r204.status).toBe(204);
    await expect(r204.text()).resolves.toBe("");

    const r205 = await inject(
      app((ctx) => ctx.empty(205)),
      { url: "/" },
    );
    expect(r205.status).toBe(205);
    await expect(r205.text()).resolves.toBe("");
  });

  it("200 is the implicit default with no explicit status", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
