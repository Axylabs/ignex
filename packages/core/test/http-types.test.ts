/**
 * Type-level tests for the schema-first route helpers (`@flux/core/http`).
 *
 * These lock the inference contract: the schema passed as the second
 * argument types `ctx.query`, `ctx.body`, and the response value. They are
 * compile-time assertions only — use `expect-type`.
 */

import { get, post } from "@flux/core/http";
import { expectTypeOf } from "expect-type";
import { describe, it } from "vitest";

describe("http route helper types", () => {
  it("infers ctx.query from a schema's `static` type", () => {
    const handler = get((ctx) => ctx.query, { query: { static: { q: 1 } } });
    type Query = Parameters<typeof handler>[0]["query"];
    expectTypeOf<Query>().toEqualTypeOf<{ q: number }>();
  });

  it("keeps ctx.query as URLSearchParams when no query schema is given", () => {
    const handler = get((ctx) => ctx.url);
    type Query = Parameters<typeof handler>[0]["query"];
    expectTypeOf<Query>().toEqualTypeOf<URLSearchParams>();
  });

  it("infers ctx.body from a post schema's `static` type", () => {
    const handler = post((ctx) => ctx.body.json(), { body: { static: { name: "x" } } });
    type Body = Parameters<typeof handler>[0]["body"];
    // TypedLazyBody.json<T = B> — B is the inferred body type.
    expectTypeOf<Body>().toMatchTypeOf<{ json(): Promise<{ name: string }> }>();
  });

  it("infers the response type from the response schema", () => {
    const handler = get((ctx) => ctx.json({ ok: true }), { response: { static: { ok: 1 } } });
    type Result = ReturnType<typeof handler>;
    // RouteResult<S> allows the inferred response object.
    expectTypeOf<Result>().toMatchTypeOf<
      Promise<Response | { ok: number }> | Response | { ok: number }
    >();
  });
});
