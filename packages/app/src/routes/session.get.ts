import { getSession } from "@ignus/core";
import { get } from "@ignus/core/http";

/** GET /session — read/write the signed-cookie session (attached by plugin). */
export default get(async (ctx) => {
  const session = await getSession(ctx);

  if (!session) {
    return ctx.json({ session: null });
  }

  const visits = ((session.data.visits as number | undefined) ?? 0) + 1;
  session.data.visits = visits;
  await session.save();

  const locale = ctx.getState<string>("locale") ?? "en";

  return ctx.json({
    id: session.id,
    visits,
    isNew: session.isNew,
    expiresAt: session.expiresAt,
    locale,
  });
});
