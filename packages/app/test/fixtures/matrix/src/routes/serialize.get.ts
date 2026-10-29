import { get } from "@ignex/core/http";
import { Type } from "typebox";

/** Response serialized per status: 200 → `{name,level}`, 201 → `{created}`. */
export default get(
  async (ctx) => {
    // No `query` schema → `ctx.query` is the URLSearchParams contract in both
    // interpreted and compiled builds (a grouped Record only appears when a
    // query schema is declared).
    if (ctx.query.get("code") === "201") {
      // Multi-status response wrapper — `RouteResult` now models
      // `{ status, body }` with body typed against the matching status schema.
      return { status: 201 as const, body: { created: true } };
    }

    return { name: "ignex", level: 1 };
  },
  {
    response: {
      200: Type.Object({ name: Type.String(), level: Type.Number() }),
      201: Type.Object({ created: Type.Boolean() }),
    },
  },
);
