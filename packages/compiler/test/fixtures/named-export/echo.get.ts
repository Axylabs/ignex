// Named-export handler using ctx — the handler's own symbol is the only
// top-level symbol, so it is an inline candidate.
export const httpGet = (ctx) => ctx.json({ hello: ctx.query.q });
