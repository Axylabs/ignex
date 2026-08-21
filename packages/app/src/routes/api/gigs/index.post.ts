import { post } from "@ignex/core/http";
import type { InsertInput } from "@ignex/ninox";
import { db } from "../../../db.js";
import type { Gig } from "../../../models/gigs.js";

type GigInput = InsertInput<Gig>;

export default post(async (ctx) => {
  const input = await ctx.body.json<GigInput>();
  const { insertedId } = await db.insertOne("gigs", input);
  return ctx.json({ id: insertedId }, { status: 201 });
});
