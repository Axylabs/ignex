/**
 * Error taxonomy tests — the enterprise error envelope and guards.
 */

import {
  BadRequestError,
  errorToResponse,
  ForbiddenError,
  HTTPError,
  InternalError,
  isHttpError,
  MethodNotAllowedError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "@ignex/core";
import { describe, expect, it } from "vitest";

describe("isHttpError", () => {
  it("narrows the full error family", () => {
    expect(isHttpError(new HTTPError(400, "x"))).toBe(true);
    expect(isHttpError(new NotFoundError())).toBe(true);
    expect(isHttpError(new ValidationError("x", {}))).toBe(true);
    expect(isHttpError(new Error("plain"))).toBe(false);
    expect(isHttpError("string")).toBe(false);
  });
});

describe("error classes", () => {
  it("carries status + stable error codes", () => {
    expect(new BadRequestError()).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(new UnauthorizedError()).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(new ForbiddenError()).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(new NotFoundError()).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(new MethodNotAllowedError("no", "GET,POST")).toMatchObject({
      status: 405,
      code: "METHOD_NOT_ALLOWED",
    });
    expect(new TooManyRequestsError("slow down", 30)).toMatchObject({
      status: 429,
      code: "TOO_MANY_REQUESTS",
    });
    expect(new InternalError()).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });

  it("produces a consistent JSON envelope", async () => {
    const res = errorToResponse(new NotFoundError("user"));
    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("user not found");
    expect(body.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("does not leak internal error details unless exposeDetails is set", async () => {
    const hidden = await errorToResponse(new Error("secret db password")).json();
    expect(hidden.error).toBe("Internal Server Error");
    expect(hidden.code).toBe("INTERNAL_ERROR");

    const shown = await errorToResponse(new Error("secret db password"), true).json();
    expect(shown.error).toBe("secret db password");
  });

  it("keeps HTTPError status codes out of the 0/1xx accidental range", () => {
    expect(new BadRequestError().toResponse().status).toBe(400);
    expect(new MethodNotAllowedError().toResponse().status).toBe(405);
  });

  it("pre-bakes identical error envelopes (deterministic + memoized body)", async () => {
    // Same error twice → identical body string on the wire, no re-alloc.
    const a = errorToResponse(new Error("boom"));
    const b = errorToResponse(new Error("boom"));
    const aBody = await a.text();
    const bBody = await b.text();
    expect(aBody).toBe(bBody);
    expect(aBody).toBe(
      JSON.stringify({ error: "Internal Server Error", status: 500, code: "INTERNAL_ERROR" }),
    );
    expect(a.headers.get("content-type")).toBe("application/json");

    // Memoized HTTPError envelope: repeated default 404 is byte-stable.
    const c = errorToResponse(new NotFoundError());
    const d = errorToResponse(new NotFoundError());
    const cBody = await c.text();
    const dBody = await d.text();
    expect(cBody).toBe(dBody);
    expect(cBody).toBe(JSON.stringify({ error: "Not Found", status: 404, code: "NOT_FOUND" }));
    expect(c.status).toBe(404);

    // With details the body is unique but still correct.
    const e = errorToResponse(new ValidationError("bad", { name: ["required"] }));
    const parsed = (await e.json()) as { details: { errors: { name: string[] } } };
    expect(e.status).toBe(422);
    expect(parsed.details.errors.name).toEqual(["required"]);
  });
});
