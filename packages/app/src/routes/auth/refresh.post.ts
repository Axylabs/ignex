import { post } from "@ignex/core/http";
import { ACCESS_TTL_SECONDS, auth, refreshTokens } from "../../lib/auth.js";

/** POST /auth/refresh — exchange a refresh token for a fresh access token. */
export default post(async (ctx) => {
  const body = await ctx.body.json<{ refreshToken?: string }>();
  const data = body.refreshToken ? await refreshTokens.consume(body.refreshToken) : null;

  if (!data) {
    return ctx.json({ error: "Invalid refresh token" }, { status: 401 });
  }

  // Rotate here if you want refresh-token reuse detection: revoke this token
  // and issue a fresh one alongside the new access token.
  const user = {
    username: String(data.sub ?? "anon"),
    roles: (data.roles as string[] | undefined) ?? [],
  };
  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles },
  );

  return ctx.json({ accessToken, expiresIn: ACCESS_TTL_SECONDS });
});
