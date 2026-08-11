// Standard-Schema WITHOUT a JSON-schema converter → build-time codegen must
// fall back to runtime validation (emitting IGN_STANDARD_SCHEMA_RUNTIME).
export const schema = {
  body: {
    "~standard": {
      version: 1,
      vendor: "unknown-vendor",
      validate: () => [],
    },
  },
};

export default async (ctx: { json: (data: unknown) => Response }) => ctx.json({ ok: true });
