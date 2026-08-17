import { post } from "@ignex/core/http";
import { refreshTokens } from "../../lib/auth.js";

/** POST /auth/logout — revoke a refresh token. */
export default post(async (ctx) => {
  const body = await ctx.body.json<{ refreshToken?: string }>();
  if (body.refreshToken) {
    await refreshTokens.revoke(body.refreshToken);
  }
  return ctx.json({ ok: true });
});
