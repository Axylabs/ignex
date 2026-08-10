import { createJwt } from "@flux/core";
import { post } from "@flux/core/http";

const jwt = createJwt({
  secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  ttlSeconds: 3600,
  issuer: "flux-demo",
});

const USERS: Record<string, string> = {
  admin: "secret",
};

/** POST /auth/login — exchange credentials for a signed JWT. */
export default post(async (ctx) => {
  const body = await ctx.body.json<{ username?: string; password?: string }>();

  if (!body.username || USERS[body.username] !== body.password) {
    return ctx.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = jwt.sign({ sub: body.username, role: "admin" });

  return ctx.json({ token });
});
