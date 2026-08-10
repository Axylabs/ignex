// Named-export handler + plain JSON schema export (hermetic, no imports).
// Exercises named-export discovery, schema detection, and validator
// precompilation without an external `@flux/core` import at build time.
export const schema = {
  query: {
    type: "object",
    properties: { q: { type: "string" } },
  },
  response: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
};

export const httpGet = async (ctx) => ctx.json({ ok: true });
