/**
 * Type-level tests for the schema-first route helpers (`@ignus/core/http`).
 *
 * These lock the inference contract: the schema passed as the second
 * argument types `ctx.query`, `ctx.body`, and the response value. They are
 * compile-time assertions only — use `expect-type`.
 */

import { get, head, options, post } from "@ignus/core/http";
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

  it("models the {status, body} multi-status wrapper per status", () => {
    const handler = get(() => ({ status: 201 as const, body: { created: true } }), {
      response: {
        200: { static: { name: "", level: 0 } },
        201: { static: { created: true } },
      },
    });
    type Result = ReturnType<typeof handler>;
    // `{status, body}` is allowed and `body` is typed against the 201 schema
    // (not the union of all response schemas).
    expectTypeOf<Result>().toMatchTypeOf<Promise<{ status: 201; body: { created: boolean } }>>();
  });

  it("exposes head/options helpers with body-less schemas", () => {
    const headHandler = head((ctx) => ctx.text(""));
    const optionsHandler = options((ctx) => ctx.text(""));
    type HeadCtx = Parameters<typeof headHandler>[0];
    type OptionsCtx = Parameters<typeof optionsHandler>[0];
    // Body is unknown (no body schema allowed on HEAD/OPTIONS) and query
    // falls back to URLSearchParams.
    expectTypeOf<HeadCtx>().toHaveProperty("query").toEqualTypeOf<URLSearchParams>();
    expectTypeOf<OptionsCtx>().toHaveProperty("query").toEqualTypeOf<URLSearchParams>();
  });
});
