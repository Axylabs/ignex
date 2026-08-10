// Schema-first route fixture: exports a plain JSON-schema `schema` used to
// verify OpenAPI schema wiring (no external imports so the build-time dynamic
// import stays hermetic).
export const schema = {
  body: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  response: {
    200: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
};

export default async (ctx: { json: (data: unknown) => Response }) => ctx.json({ ok: true });
