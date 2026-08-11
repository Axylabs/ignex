/**
 * Shared auth hook: verifies an HS256 Bearer token and attaches the claims to
 * `ctx.state.user`. Used by routes via `export const config = { hooks: [...] }`.
 */
import { continueHook, type HookFn, haltHook, jwtVerify } from "@ignus/core";

export default (async (ctx) => {
  const header = ctx.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const claims = token ? jwtVerify(token, process.env.JWT_SECRET ?? "dev-secret-change-me") : null;

  if (!claims) {
    return haltHook(Response.json({ error: "Unauthorized" }, { status: 401 }));
  }

  ctx.setState("user", claims);
  return continueHook(ctx);
}) as HookFn;
