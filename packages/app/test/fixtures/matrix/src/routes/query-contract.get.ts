import { get } from "@ignex/core/http";
import { Type } from "typebox";

const response = Type.Object({ value: Type.Union([Type.String(), Type.Null()]) });

/**
 * No `query` schema → `ctx.query` is URLSearchParams in every build shape.
 * Regression: the full-context prelude used to shadow it with a grouped
 * Record, so `.get()` threw only in AOT builds.
 */
export default get((ctx) => ctx.json({ value: ctx.query.get("q") }), { response });
