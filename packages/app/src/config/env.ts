/**
 * App environment configuration — validated with TypeBox.
 *
 * Every variable is optional with a sensible default (so a fresh checkout
 * boots without setup), except `SESSION_SECRET` which is optional-without-a-
 * default: a missing value logs a warning at boot and `src/app.config.ts`
 * falls back to a dev secret. Mark secrets with `metadata.secret` so their
 * values never leak into validation errors.
 */
import { defineEnv, Type } from "@ignex/core/env";

export const envSchema = Type.Object({
  NODE_ENV: Type.String({ default: "development" }),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  DEBUG: Type.Boolean({ default: false }),
  FEATURES: Type.Array(Type.String(), { default: [] }),
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
});

/** Validated, frozen, fully-typed environment. */
export const env = defineEnv(envSchema);
