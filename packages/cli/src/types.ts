export const FEATURE_NAMES = [
  "cors",
  "rateLimit",
  "security",
  "compression",
  "logger",
  "openapi",
  "files",
  "ws",
  "sse",
  "cache",
  "proxy",
  "cluster",
  "auth",
  "sessions",
  "templates",
  "env",
  "jobs",
  "i18n",
  "examples",
  "tests",
] as const;

export type Feature = (typeof FEATURE_NAMES)[number];
