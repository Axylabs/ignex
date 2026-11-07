import { post } from "@ignex/core/http";
import { enqueueRigJob } from "../lib/job-rig.js";

/** POST /jobs-rig — enqueue a rig job (`{"kind":"ok"|"failing"}`); returns its id. */
export default post(async (ctx) => {
  const body = await ctx.body.json<{ kind?: string }>();
  const kind = body?.kind === "failing" ? "failing" : "ok";
  return ctx.json({ id: enqueueRigJob(kind), kind }, { status: 201 });
});
