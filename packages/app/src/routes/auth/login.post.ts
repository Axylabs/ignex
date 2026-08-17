import { post } from "@ignex/core/http";
import { ACCESS_TTL_SECONDS, auth, refreshTokens, userStore } from "../../lib/auth.js";

/** POST /auth/login — exchange credentials for access + refresh tokens. */
export default post(async (ctx) => {
  const body = await ctx.body.json<{ username?: string; password?: string }>();

  const user = await userStore.verify(body.username ?? "", body.password ?? "");
  if (!user) {
    return ctx.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles },
  );

  const refreshToken = await refreshTokens.issue(user);
  return ctx.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS });
});
