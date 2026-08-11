import { get } from "@ignus/core/http";

export const config = { hooks: ["require-auth"] };

/** GET /auth/me — returns the authenticated user's claims (JWT-guarded). */
export default get(async (ctx) => {
  return ctx.json({
    user: ctx.getState("user") ?? null,
  });
});
