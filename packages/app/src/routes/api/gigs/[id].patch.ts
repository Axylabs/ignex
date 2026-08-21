import { NotFoundError } from "@ignex/core";
import { patch } from "@ignex/core/http";
import type { UpdateInput } from "@ignex/ninox";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { db } from "../../../db.js";
import type { Gig } from "../../../models/gigs.js";

type GigUpdate = UpdateInput<Gig>;

export default patch(
  async (ctx) => {
    const _id = new ObjectId(ctx.params.id);
    const body = await ctx.body.json<GigUpdate>();
    const result = await db.updateOne("gigs", { _id }, body);
    if (result.modifiedCount === 0) throw new NotFoundError();
    return ctx.json({ updated: true });
  },
  {
    params: Type.Object({ id: Type.String({ pattern: "^[0-9a-fA-F]{24}$" }) }),
  },
);
