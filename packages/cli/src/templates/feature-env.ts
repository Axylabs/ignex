/**
 * @fileoverview Feature-bundle env vocabulary — the env vars each feature
 * declares, plus the helpers `ignex create` uses to emit them into the
 * scaffolded schema/`.env.example`. Split from `./features.ts` (size gate);
 * `ignex add` reaches the same vocabulary through `planInstall().envVars`
 * and wires it post-hoc via `utils/env-vars.ts` — one vocabulary, both
 * commands.
 *
 * Entry shapes mirror `utils/db-env.ts`: an indented `envSchema` line with
 * trailing comma, and a two-line `.env.example` section.
 */
import { FEATURE_NAMES, type Feature } from "../types.js";

/**
 * An env var a feature bundle contributes: the exact `src/config/env.ts`
 * schema entry (indented, with trailing comma) and the matching
 * `.env.example` section — the same shapes `utils/db-env.ts` writes.
 */
export interface FeatureEnvVar {
  /** Env var name (also the idempotency key). */
  readonly key: string;
  /** Indented schema entry line, e.g. `  KEY: Type.Optional(Type.String()),`. */
  readonly schemaLine: string;
  /** `.env.example` section appended when the var is new. */
  readonly example: string;
}

/**
 * Env vars each feature declares. `ignex add` wires them into the project's
 * env config (via `planInstall` → `utils/env-vars.ts`); `ignex create`
 * emits them into the scaffolded schema + `.env.example`.
 */
export const FEATURE_ENV_VARS: Partial<Record<Feature, readonly FeatureEnvVar[]>> = {
  metrics: [
    {
      key: "METRICS_TOKEN",
      schemaLine: "  METRICS_TOKEN: Type.Optional(Type.String({ metadata: { secret: true } })),",
      example:
        "# OPTIONAL (secret) — METRICS_TOKEN · Bearer token protecting GET /metrics\nMETRICS_TOKEN=",
    },
    {
      key: "OTLP_ENDPOINT",
      schemaLine: "  OTLP_ENDPOINT: Type.Optional(Type.String()),",
      example: "# OPTIONAL — OTLP_ENDPOINT · OTLP/HTTP endpoint for metrics push\nOTLP_ENDPOINT=",
    },
  ],
  realtime: [
    {
      key: "NOVA_PORT",
      schemaLine: "  NOVA_PORT: Type.Integer({ default: 3001 }),",
      example: "# OPTIONAL — NOVA_PORT (default: 3001) · realtime hub WS port\nNOVA_PORT=3001",
    },
  ],
  mailer: [
    {
      key: "SMTP_HOST",
      schemaLine: "  SMTP_HOST: Type.Optional(Type.String()),",
      example: "# OPTIONAL — SMTP_HOST · empty = log driver (no real sends)\nSMTP_HOST=",
    },
    {
      key: "SMTP_PORT",
      schemaLine: "  SMTP_PORT: Type.Integer({ default: 587 }),",
      example: "# OPTIONAL — SMTP_PORT (default: 587)\nSMTP_PORT=587",
    },
    {
      key: "SMTP_USER",
      schemaLine: "  SMTP_USER: Type.Optional(Type.String()),",
      example: "# OPTIONAL — SMTP_USER\nSMTP_USER=",
    },
    {
      key: "SMTP_PASS",
      schemaLine: "  SMTP_PASS: Type.Optional(Type.String({ metadata: { secret: true } })),",
      example: "# OPTIONAL (secret) — SMTP_PASS\nSMTP_PASS=",
    },
    {
      key: "SMTP_FROM",
      schemaLine: "  SMTP_FROM: Type.Optional(Type.String()),",
      example: "# OPTIONAL — SMTP_FROM · default From address\nSMTP_FROM=",
    },
  ],
};

/**
 * Schema entry lines (for `envConfigTemplate`) declared by the selected
 * features — the `ignex create` counterpart of `wireFeatureEnvVars`.
 *
 * @param features - The resolved feature selection.
 * @returns Indented schema entry lines, feature-canonical order, deduped.
 */
export function featureEnvSchemaLines(features: ReadonlySet<Feature>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const feature of FEATURE_NAMES) {
    if (!features.has(feature)) continue;
    for (const envVar of FEATURE_ENV_VARS[feature] ?? []) {
      if (seen.has(envVar.key)) continue;
      seen.add(envVar.key);
      lines.push(envVar.schemaLine);
    }
  }
  return lines;
}

/**
 * `.env.example` sections (for `envExampleTemplate`) declared by the
 * selected features — mirrors {@link featureEnvSchemaLines}.
 */
export function featureEnvExampleSections(features: ReadonlySet<Feature>): string[] {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const feature of FEATURE_NAMES) {
    if (!features.has(feature)) continue;
    for (const envVar of FEATURE_ENV_VARS[feature] ?? []) {
      if (seen.has(envVar.key)) continue;
      seen.add(envVar.key);
      sections.push(envVar.example);
    }
  }
  return sections;
}
