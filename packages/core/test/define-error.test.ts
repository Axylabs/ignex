/**
 * @fileoverview `defineError` — a domain error that is already an HTTP answer.
 *
 * Pins the contract the app modules rely on: conventional code→status mapping
 * with no configuration, per-code overrides, a derived client-code prefix, and
 * pass-through of the framework's error boundary (`errorToResponse`), so a route
 * needs neither a mapper nor a `try/catch`.
 */

import { defineError, errorToResponse, HTTPError, RequestError } from "@ignex/core";
import { describe, expect, it } from "vitest";

const AdminError = defineError<"NOT_FOUND" | "FORBIDDEN" | "INVALID_STATUS" | "INVALID_INPUT">(
  "AdminError",
);

const BillingError = defineError<"NOT_FOUND" | "VENUE_CONFLICT" | "INVALID_STATE">("BillingError", {
  codes: { VENUE_CONFLICT: 409 },
  fallbackStatus: 422,
  messages: { NOT_FOUND: "billing record not found" },
});

const AccessError = defineError<"FORBIDDEN" | "NOT_FOUND">("OrgAccessError", {
  code: "ORG_FORBIDDEN",
});

describe("defineError — conventional mapping without configuration", () => {
  it("answers the conventional status for each known code", () => {
    expect(new AdminError("gone", "NOT_FOUND").status).toBe(404);
    expect(new AdminError("nope", "FORBIDDEN").status).toBe(403);
    expect(new AdminError("late", "INVALID_STATUS").status).toBe(409);
  });

  it("maps validation-ish codes to 422 and unknown codes to the fallback", () => {
    expect(new AdminError("bad", "INVALID_INPUT").status).toBe(422);
    const Odd = defineError<"SOMETHING_ELSE">("OddError");
    expect(new Odd("odd", "SOMETHING_ELSE").status).toBe(400);
  });

  it("sends the domain code itself, so a service can branch on error.code", () => {
    const error = new AdminError("gone", "NOT_FOUND");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.domainCode).toBe("NOT_FOUND");
    expect(error.name).toBe("AdminError");
  });

  it("is an HTTPError, so the boundary answers with the declared status", () => {
    const error = new AdminError("gone", "NOT_FOUND");
    expect(error).toBeInstanceOf(HTTPError);
    const response = errorToResponse(error, false);
    expect(response.status).toBe(404);
  });
});

describe("defineError — per-module overrides", () => {
  it("honours explicit statuses, fallback, and message overrides", () => {
    const conflict = new BillingError("slot taken", "VENUE_CONFLICT");
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("VENUE_CONFLICT");

    const unknown = new BillingError("unknown plan", "NOT_FOUND");
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("billing record not found");

    expect(new BillingError("bad state", "INVALID_STATE").status).toBe(409);
  });

  it("supports a fixed client code (one code for every domain code)", () => {
    expect(new AccessError("denied", "FORBIDDEN").code).toBe("ORG_FORBIDDEN");
    expect(new AccessError("gone", "NOT_FOUND").code).toBe("ORG_FORBIDDEN");
    expect(new AccessError("gone", "NOT_FOUND").status).toBe(404);
  });

  it("namespaces codes only when a module opts in", () => {
    const Prefixed = defineError<"NOT_FOUND">("PrefixedError", { prefix: "BILLING" });
    const error = new Prefixed("gone", "NOT_FOUND");
    expect(error.code).toBe("BILLING_NOT_FOUND");
    expect(error.domainCode).toBe("NOT_FOUND");
  });

  it("exposes the configured status table for diagnostics", () => {
    expect(AdminError.statuses.NOT_FOUND).toBe(404);
    expect(AdminError.fallbackStatus).toBe(400);
    expect(BillingError.fallbackStatus).toBe(422);
  });
});

describe("defineError — boundary behaviour", () => {
  it("keeps the framework's own errors untouched", () => {
    const response = errorToResponse(new RequestError(409, "clash", "CLASH"), false);
    expect(response.status).toBe(409);
  });

  it("does not leak a 5xx message", async () => {
    const UpstreamError = defineError<"UPSTREAM_DOWN">("UpstreamError", {
      codes: { UPSTREAM_DOWN: 502 },
    });
    const response = errorToResponse(
      new UpstreamError("connect ECONNREFUSED 10.0.0.1:5432", "UPSTREAM_DOWN"),
      false,
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("UPSTREAM_DOWN");
    expect(body.error).not.toContain("ECONNREFUSED");
  });
});
