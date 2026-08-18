/**
 * Scaffold env-config templates.
 *
 * `envConfigTemplate` emits the project's `src/config/env.ts` (a TypeBox
 * schema + `defineEnv`), and `envExampleTemplate` derives `.env.example` from
 * the SAME schema object via `envExampleFromSchema` so the two never drift.
 *
 * Note: `SCAFFOLD_ENV_SCHEMA` (the runtime object) and the schema source
 * emitted by `envConfigTemplate` must stay in sync — keep them in this file
 * and covered by the scaffold tests.
 */
import { envExampleFromSchema } from "@ignex/core/env";
import { Type } from "typebox";

/** The scaffold's default env schema (object form, used for `.env.example`). */
export const SCAFFOLD_ENV_SCHEMA = Type.Object({
  NODE_ENV: Type.String({ default: "development" }),
  HOST: Type.String({ default: "0.0.0.0" }),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  LOG_LEVEL: Type.Union(
    [Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")],
    { default: "info" },
  ),
  DEBUG: Type.Boolean({ default: false }),
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
});

/** The project's `src/config/env.ts` (source form of {@link SCAFFOLD_ENV_SCHEMA}). */
export function envConfigTemplate(): string {
  return `import { Type, defineEnv } from "@ignex/core/env";

/**
 * Environment configuration — validated with TypeBox.
 *
 * A \`default\` makes a variable optional (missing → default, no warning) and
 * keeps the static type non-null. Wrap in \`Type.Optional\` only when the type
 * should include \`undefined\`. \`metadata.secret\` redacts values from errors.
 *
 * Copy .env.example to .env and adjust:  cp .env.example .env
 */
export const envSchema = Type.Object({
  NODE_ENV: Type.String({ default: "development" }),
  HOST: Type.String({ default: "0.0.0.0" }),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  LOG_LEVEL: Type.Union(
    [Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")],
    { default: "info" },
  ),
  DEBUG: Type.Boolean({ default: false }),
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
});

/** Validated, frozen, fully-typed environment. */
export const env = defineEnv(envSchema);
`;
}

/** The project's `.env.example`, derived from {@link SCAFFOLD_ENV_SCHEMA}. */
export function envExampleTemplate(): string {
  return envExampleFromSchema(SCAFFOLD_ENV_SCHEMA);
}
