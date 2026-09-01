// Wildcard route (`*path`) — keeps the generic runtime-checked wrapper.
export default async (ctx) => ctx.json({ file: ctx.params.path });
