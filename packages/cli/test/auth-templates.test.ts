/**
 * Generator tests for the auth scaffold (`ignex create --features auth[,refresh]`).
 *
 * Covers the auth lib + route templates (register/login/me/refresh/logout and
 * the require-auth hook) and feature-gating: with `refresh` off, no opaque
 * refresh-token code is emitted; with it on, refresh issuance/revocation is.
 */
import { expect, test } from "vitest";
import { parseFeatures } from "../src/commands/create.js";
import {
  authLibTemplate,
  loginRouteTemplate,
  logoutRouteTemplate,
  meRouteTemplate,
  refreshRouteTemplate,
  registerRouteTemplate,
  requireAuthHookTemplate,
} from "../src/templates/routes.js";
import { FEATURE_NAMES } from "../src/types.js";

test("FEATURE_NAMES includes auth and refresh", () => {
  expect(FEATURE_NAMES).toContain("auth");
  expect(FEATURE_NAMES).toContain("refresh");
});

test("parseFeatures resolves canonical auth/refresh/sessions tokens", () => {
  expect(parseFeatures("auth,refresh")).toEqual(new Set(["auth", "refresh"]));
  expect(parseFeatures("auth")).toEqual(new Set(["auth"]));
  expect(parseFeatures("refresh")).toEqual(new Set(["refresh"]));
  expect(parseFeatures("refresh-tokens")).toEqual(new Set(["refresh"]));
  expect(parseFeatures("sessions")).toEqual(new Set(["sessions"]));
  expect(parseFeatures("all")).toEqual(new Set(FEATURE_NAMES));
});

test("authLibTemplate without refresh omits the refresh-token manager", () => {
  const code = authLibTemplate({ refresh: false });
  expect(code).toContain("createAuthModule");
  expect(code).toContain("createPasswordHasher");
  expect(code).toContain("export const requireAuth = auth.middleware();");
  expect(code).toContain("export const userStore =");
  expect(code).not.toContain("randomToken");
  expect(code).not.toContain("createMemorySessionStore");
  expect(code).not.toContain("refreshTokens");
});

test("authLibTemplate with refresh emits the revocable refresh manager", () => {
  const code = authLibTemplate({ refresh: true });
  expect(code).toContain("createMemorySessionStore");
  expect(code).toContain("randomToken(32)");
  expect(code).toContain("type SessionStore");
  expect(code).toContain("export const refreshTokens =");
  expect(code).toContain("async issue");
  expect(code).toContain("async consume");
  expect(code).toContain("async revoke");
});

test("loginRouteTemplate without refresh issues an access token only", () => {
  const code = loginRouteTemplate({ refresh: false });
  expect(code).toContain(
    'import { ACCESS_TTL_SECONDS, auth, userStore } from "../../lib/auth.js";',
  );
  expect(code).toContain("userStore.verify");
  expect(code).toContain("auth.issueToken");
  expect(code).toContain("return ctx.json({ accessToken, expiresIn: ACCESS_TTL_SECONDS });");
  expect(code).not.toContain("refreshTokens");
  expect(code).not.toContain("refreshToken");
});

test("loginRouteTemplate with refresh issues access + refresh tokens", () => {
  const code = loginRouteTemplate({ refresh: true });
  expect(code).toContain("refreshTokens");
  expect(code).toContain("const refreshToken = await refreshTokens.issue(user);");
  expect(code).toContain(
    "return ctx.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS });",
  );
});

test("registerRouteTemplate creates a user and returns 201", () => {
  const code = registerRouteTemplate({ refresh: true });
  expect(code).toContain("userStore.create");
  expect(code).toContain('{ error: "User already exists" }, { status: 409 }');
  expect(code).toContain("{ status: 201 }");
  expect(code).toContain("const refreshToken = await refreshTokens.issue(user);");
});

test("refreshRouteTemplate consumes the refresh token and issues a new access token", () => {
  const code = refreshRouteTemplate();
  expect(code).toContain("refreshTokens.consume");
  expect(code).toContain('{ error: "Invalid refresh token" }, { status: 401 }');
  expect(code).toContain("auth.issueToken");
});

test("logoutRouteTemplate revokes the refresh token", () => {
  const code = logoutRouteTemplate();
  expect(code).toContain("refreshTokens.revoke");
  expect(code).toContain("return ctx.json({ ok: true });");
});

test("requireAuthHookTemplate is a thin wrapper over the auth module hook", () => {
  const code = requireAuthHookTemplate();
  expect(code).toContain('import { requireAuth } from "../lib/auth.js";');
  expect(code).toContain("export default requireAuth;");
});

test("meRouteTemplate reads the user via getUser and stays hook-gated", () => {
  const code = meRouteTemplate();
  expect(code).toContain('import { getUser } from "@ignex/core";');
  expect(code).toContain('export const config = { hooks: ["require-auth"] };');
  expect(code).toContain("getUser(ctx)");
});
