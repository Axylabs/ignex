// Named-export handler using ctx.loader — forces the full context in codegen
// so `loader` is available at runtime.
export const httpGet = (ctx) => {
  const users = ctx.loader(async (keys) => keys.map((k) => ({ id: k })));
  return ctx.json({ ok: true, loader: typeof users.load });
};
