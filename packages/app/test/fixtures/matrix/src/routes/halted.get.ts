import { get } from "@ignex/core/http";

/** A guard-style halt: the response pipeline must still decorate it. */
export default get(() => ({ ok: true }), {
  before: [
    () => ({
      ok: false as const,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    }),
  ],
});
