// Body-reading route fixture: the handler reads `ctx.body`, so its body can
// NOT be validated native-only (validate-and-ack) — the JS parse is required
// and the route stays on the plain JS prelude (not `nativeRoutes` eligible
// for the body part).
export const schema = {
  body: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  response: {
    type: "object",
    properties: { name: { type: "string" } },
  },
};

export default async (ctx: { body: { json: () => Promise<{ name: string }> } }) => {
  const body = await ctx.body.json();
  return ctx.json({ name: body.name });
};
