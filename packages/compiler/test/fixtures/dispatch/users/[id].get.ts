// Param route (`:id`), async — static variant (no wildcard block) with the
// promise funnel intact.
export default async (ctx) => ctx.json({ id: ctx.params.id });
