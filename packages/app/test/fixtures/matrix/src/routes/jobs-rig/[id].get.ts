import { get } from "@ignex/core/http";
import { jobs } from "../../lib/job-rig.js";

/** GET /jobs-rig/:id — poll a rig job's lifecycle state and attempt count. */
export default get(async (ctx) => {
  const record = jobs.get(ctx.params.id ?? "");
  if (!record) {
    return ctx.json({ error: "unknown job" }, { status: 404 });
  }
  return ctx.json({ state: record.state, attempts: record.attempts });
});
