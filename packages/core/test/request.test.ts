/**
 * `defineRequest` — FormRequest-style validation objects.
 *
 * Covers: body/params/query extraction + validation (422 per-field errors),
 * the `authorize` gate (403), and the returned `part`.
 */

import { createContext, defineRequest, ValidationForbiddenError } from "@ignex/core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

const ctxFor = (req: Request) => createContext(req, {});

describe("defineRequest", () => {
  it("validates the body and returns the coerced value", async () => {
    const CreateUser = defineRequest({
      part: "body",
      schema: Type.Object({
        email: Type.String(),
        age: Type.Number(),
      }),
    });
    const ctx = ctxFor(
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.c", age: 3 }),
      }),
    );
    const value = await CreateUser.validate(ctx);
    expect(value).toMatchObject({ email: "a@b.c", age: 3 });
  });

  it("throws a 422 ValidationError with per-field errors on invalid input", async () => {
    const CreateUser = defineRequest({
      part: "body",
      schema: Type.Object({ email: Type.String({ minLength: 5 }) }),
    });
    const ctx = ctxFor(
      new Request("http://x/", { method: "POST", body: JSON.stringify({ email: "a" }) }),
    );
    await expect(CreateUser.validate(ctx)).rejects.toMatchObject({ status: 422 });
  });

  it("runs authorize before validation (403 when rejected)", async () => {
    const AdminOnly = defineRequest({
      part: "body",
      schema: Type.Object({ name: Type.String() }),
      authorize: () => false,
    });
    const ctx = ctxFor(
      new Request("http://x/", { method: "POST", body: JSON.stringify({ name: "n" }) }),
    );
    await expect(AdminOnly.validate(ctx)).rejects.toBeInstanceOf(ValidationForbiddenError);
    await expect(AdminOnly.validate(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it("validates params", async () => {
    const ById = defineRequest({
      part: "params",
      schema: Type.Object({ id: Type.String({ minLength: 1 }) }),
    });
    // params are the 2nd createContext arg (matched route params).
    const value = await ById.validate(
      createContext(new Request("http://x/"), { id: "42" }) as never,
    );
    expect(value).toMatchObject({ id: "42" });
  });

  it("defaults to the body part", () => {
    const Req = defineRequest({ schema: Type.Object({}) });
    expect(Req.part).toBe("body");
  });
});
