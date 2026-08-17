import { post } from "@ignex/core/http";
import { ACCESS_TTL_SECONDS, auth, refreshTokens, userStore } from "../../lib/auth.js";

/** POST /auth/register — create a user and return access + refresh tokens. */
export default post(async (ctx) => {
  const body = await ctx.body.json<{ username?: string; password?: string; roles?: string[] }>();

  if (!body.username || !body.password) {
    return ctx.json({ error: "username and password are required" }, { status: 400 });
  }

  const user = await userStore.create(body.username, body.password, body.roles ?? ["user"]);
  if (!user) {
    return ctx.json({ error: "User already exists" }, { status: 409 });
  }

  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles },
  );

  const refreshToken = await refreshTokens.issue(user);
  return ctx.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }, { status: 201 });
});
