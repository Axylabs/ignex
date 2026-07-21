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
  "examples",
  "tests",
] as const;

export type Feature = (typeof FEATURE_NAMES)[number];