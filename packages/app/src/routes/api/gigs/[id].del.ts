import { NotFoundError } from "@ignex/core";
import { del } from "@ignex/core/http";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { db } from "../../../db.js";

export default del(
  async (ctx) => {
    const _id = new ObjectId(ctx.params.id);
    const result = await db.deleteOne("gigs", { _id });
    if (result.deletedCount === 0) throw new NotFoundError();
    return ctx.json({ deleted: true });
  },
  {
    params: Type.Object({ id: Type.String({ pattern: "^[0-9a-fA-F]{24}$" }) }),
  },
);
