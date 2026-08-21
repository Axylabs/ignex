import { NotFoundError } from "@ignex/core";
import { get } from "@ignex/core/http";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { db } from "../../../db.js";

export default get(
  async (ctx) => {
    const _id = new ObjectId(ctx.params.id);
    const doc = await db.getOne("gigs", { _id });
    if (!doc) throw new NotFoundError();
    return ctx.json(doc);
  },
  {
    params: Type.Object({ id: Type.String({ pattern: "^[0-9a-fA-F]{24}$" }) }),
  },
);
