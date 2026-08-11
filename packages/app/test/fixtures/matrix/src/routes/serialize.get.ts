import { get } from "@flux/core/http";
import { Type } from "@sinclair/typebox";

/** Response serialized per status: 200 → `{name,level}`, 201 → `{created}`. */
export default get(
  async (ctx) => {
    // With a response schema the route runs the full context path, where
    // `ctx.query` is a `Record<string,string|string[]>` (not URLSearchParams).
    const query = ctx.query as unknown as Record<string, string | string[]>;

    if (query.code === "201") {
      // Multi-status response wrapper — `RouteResult` now models
      // `{ status, body }` with body typed against the matching status schema.
      return { status: 201 as const, body: { created: true } };
    }

    return { name: "flux", level: 1 };
  },
  {
    response: {
      200: Type.Object({ name: Type.String(), level: Type.Number() }),
      201: Type.Object({ created: Type.Boolean() }),
    },
  },
);
