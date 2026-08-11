// Standard-Schema route fixture: a body expressed as a Standard-Schema object
// that exposes a `toJSONSchema()` converter (like ArkType). No external imports
// so the build-time dynamic import stays hermetic.
const standardBody = {
  "~standard": {
    version: 1,
    vendor: "mock",
    validate: () => [],
  },
  toJSONSchema() {
    return {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
  },
};

export const schema = {
  body: standardBody,
  response: {
    200: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
};

export default async (ctx: { json: (data: unknown) => Response }) => ctx.json({ ok: true });
