/**
 * @fileoverview Port of Elysia `test/core/handle-error.test.ts`,
 * `test/lifecycle/http-error.test.ts`, `test/lifecycle/error.test.ts`,
 * `test/core/error-tail-mask.test.ts` — error-to-response mapping and the
 * `error` lifecycle stage on the interpreted `createApp().handler()` path.
 *
 * IgnEx envelope: `{ error, status, code, details? }`. Unlike Elysia's
 * RFC-7807 `problem()` default, IgnEx never leaks the internal message of a
 * non-HTTP error unless `exposeErrors` is enabled (tail masking).
 */

import {
  BadRequestError,
  ConflictError,
  createApp,
  ForbiddenError,
  InternalError,
  MethodNotAllowedError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"], exposeErrors = false) =>
  createApp({ handler, exposeErrors });

describe("HTTPError family → responses", () => {
  it.each([
    [new BadRequestError(), 400, "BAD_REQUEST", "Bad Request"],
    [new UnauthorizedError(), 401, "UNAUTHORIZED", "Unauthorized"],
    [new ForbiddenError(), 403, "FORBIDDEN", "Forbidden"],
    [new NotFoundError(), 404, "NOT_FOUND", "Not Found"],
    [new ConflictError(), 409, "CONFLICT", "Conflict"],
    [new TooManyRequestsError(), 429, "TOO_MANY_REQUESTS", "Too Many Requests"],
    [new InternalError(), 500, "INTERNAL_ERROR", "Internal Server Error"],
  ] as const)("maps %s to %i %s", async (error, status, code) => {
    const res = await inject(
      app(() => {
        throw error;
      }),
      { url: "/" },
    );

    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ status, code });
  });

  it("maps a ValidationError to 422 with field errors", async () => {
    const res = await inject(
      app(() => {
        throw new ValidationError("validation failed", { name: ["must be a string"] });
      }),
      { url: "/" },
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { errors: { name: ["must be a string"] } },
    });
  });

  it("maps a MethodNotAllowedError to 405 and exposes Allow", async () => {
    const res = await inject(
      app(() => {
        throw new MethodNotAllowedError("Method Not Allowed", "GET, POST");
      }),
      { url: "/" },
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });

  it("carries custom details on the envelope", async () => {
    const res = await inject(
      app(() => {
        throw new BadRequestError("bad input");
      }),
      { url: "/" },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad input", code: "BAD_REQUEST" });

    const res2 = await inject(
      app(() => {
        throw new NotFoundError("missing");
      }),
      { url: "/" },
    );
    await expect(res2.json()).resolves.toMatchObject({ error: "missing not found" });
  });
});

describe("error tail masking (no detail leak)", () => {
  it("hides the internal message of a thrown Error by default", async () => {
    const res = await inject(
      app(() => {
        throw new Error("kaboom-secret");
      }),
      { url: "/" },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).not.toContain("kaboom-secret");
  });

  it("exposes the message when exposeErrors is enabled", async () => {
    const res = await inject(
      app(() => {
        throw new Error("kaboom-secret");
      }, true),
      { url: "/" },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("kaboom-secret");
  });

  it("adds security headers to error envelopes", async () => {
    const res = await inject(
      app(() => {
        throw new NotFoundError();
      }),
      { url: "/" },
    );

    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("error lifecycle stage", () => {
  it("lets an error hook replace the response", async () => {
    const app = createApp({
      lifecycle: {
        error: [
          {
            fn: (_ctx, err) =>
              new Response(`caught:${(err as Error).message}`, {
                status: 418,
                headers: { "content-type": "text/plain" },
              }),
          },
        ],
      },
      handler: () => {
        throw new Error("boom");
      },
    });

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(418);
    await expect(res.text()).resolves.toBe("caught:boom");
  });

  it("degrades to 500 when the error hook itself throws (does not mask original)", async () => {
    const app = createApp({
      lifecycle: {
        error: [
          {
            fn: () => {
              throw new Error("hook throws");
            },
          },
        ],
      },
      handler: () => {
        throw new Error("boom");
      },
    });

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("routes a thrown hook error through the error stage", async () => {
    const app = createApp({
      lifecycle: {
        error: [
          {
            fn: (_ctx, err) =>
              new Response(`error-stage:${(err as Error).name}`, {
                status: 400,
                headers: { "content-type": "text/plain" },
              }),
          },
        ],
        beforeHandle: [
          {
            fn: () => {
              throw new Error("hook-boom");
            },
          },
        ],
      },
      handler: (ctx) => ctx.json({ ok: true }),
    });

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toBe("error-stage:Error");
  });
});
