import { get } from "@ignex/core/http";

/** GET /slow — long enough that a SIGTERM lands while it is still in flight. */
export default get(async (ctx) => {
  // Observable handler-entry marker: the second-signal journey waits for this
  // before sending the first SIGTERM, so the drain is guaranteed to have an
  // in-flight request (a signal before this line drains instantly instead).
  console.log("[slow-start]");
  await new Promise((resolve) => setTimeout(resolve, 400));
  return ctx.json({ slow: true });
});
