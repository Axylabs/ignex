import { getUser } from "@ignex/core";
import { get } from "@ignex/core/http";

export const config = { hooks: ["require-auth"] };

/** GET /auth/me — returns the authenticated user's claims (JWT-guarded). */
export default get(async (ctx) => {
  return ctx.json({
    user: getUser(ctx) ?? null,
  });
});
