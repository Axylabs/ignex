/**
 * @fileoverview `defineRequest` — FormRequest-style request validation objects.
 *
 * DX sugar over the existing Standard-Schema validation, inspired by Laravel's
 * Form Requests: declare WHICH request part to validate and its schema once,
 * then `await request.validate(ctx)` in any handler — it extracts the part,
 * validates it, and throws a 422 `ValidationError` with a per-field error map
 * on failure. An optional `authorize(ctx)` hook runs before validation and
 * short-circuits with a 403.
 *
 * ```ts
 * import { defineRequest } from "@ignex/core";
 * import { Type } from "typebox";
 *
 * const CreateUser = defineRequest({
 *   part: "body",                          // body | query | params | headers
 *   schema: Type.Object({
 *     email: Type.String({ format: "email" }),
 *     role: Type.Optional(Type.Union([Type.Literal("admin"), Type.Literal("user")])),
 *   }),
 *   // optional: authorization gate (403 when false)
 *   authorize: (ctx) => ctx.state.user?.role === "admin",
 * });
 *
 * // in a route:
 * const input = await CreateUser.validate(ctx);   // validated + typed
 * ```
 */
import type { IgnexContext } from "../http/context";
import { headersToRecord } from "../http/headers";
import { validateAsync } from "./schema";

/** Which request part a request object validates. */
export type RequestPart = "body" | "query" | "params" | "headers";

/** Options for {@link defineRequest}. */
export interface RequestOptions<TSchema = unknown> {
  /** Which request part to validate (default `"body"`). */
  part?: RequestPart;
  /** The Standard-Schema / JSON-Schema to validate the part against. */
  schema: TSchema;
  /**
   * Optional authorization gate. When it returns false, validation fails with
   * 403 instead of running (the classic FormRequest `authorize()`).
   */
  authorize?: (ctx: IgnexContext) => boolean | Promise<boolean>;
}

/** A defined request object. */
export interface DefinedRequest<TValue = unknown> {
  /** Validate the configured part of `ctx`; throws 422 (or 403) on failure. */
  validate(ctx: IgnexContext): Promise<TValue>;
  /** The configured request part. */
  readonly part: RequestPart;
}

/** Extract the raw value of a request part from the context. */
async function extractPart(ctx: IgnexContext, part: RequestPart): Promise<unknown> {
  switch (part) {
    case "body":
      return ctx.body.json();
    case "query":
      return Object.fromEntries(ctx.query.entries());
    case "params":
      return ctx.params;
    case "headers":
      return headersToRecord(ctx.headers);
  }
}

/**
 * Define a FormRequest-style validation object. `validate(ctx)` extracts the
 * configured part, runs `authorize` (403 when false), validates the schema
 * (422 `ValidationError` with per-field errors), and returns the validated
 * value.
 */
export const defineRequest = <TSchema, TValue = unknown>(
  options: RequestOptions<TSchema> & { schema: TSchema },
): DefinedRequest<TValue> => {
  const part = options.part ?? "body";
  const authorize = options.authorize;

  return {
    part,
    async validate(ctx): Promise<TValue> {
      if (authorize) {
        const allowed = await authorize(ctx);
        if (!allowed) {
          throw new ValidationForbiddenError();
        }
      }
      const raw = await extractPart(ctx, part);
      return validateAsync<TValue>(options.schema as never, raw, part);
    },
  };
};

/** 403 thrown when a request's `authorize` hook rejects. */
export class ValidationForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super("Forbidden: this request is not authorized.");
    this.name = "ValidationForbiddenError";
  }
}
