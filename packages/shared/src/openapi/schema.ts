/**
 * @fileoverview OpenAPI schema shaping — type guards and path/operation
 * vocabulary helpers shared by the generator stages.
 */

/** True when `value` is a plain (non-array) record. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when `value` is a record carrying a `properties` record. */
export const hasProperties = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && isRecord(value.properties);

/** The `properties` record of an object schema, if present. */
export const propertiesOf = (schema: unknown): Record<string, unknown> | undefined =>
  hasProperties(schema) ? (schema.properties as Record<string, unknown>) : undefined;

/** `{ "200": schema, "404": schema }` style response maps. */
export const isStatusMap = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => /^\d{3}$/.test(key));
};

/** The `required` string list of an object schema, if present. */
export const requiredOf = (schema: unknown): readonly string[] => {
  if (!isRecord(schema)) return [];
  const required = schema.required;
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string")
    : [];
};

/** Clone a schema, dropping `$id` (which must be unique per document). */
export const stripId = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripId);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$id") continue;
    next[key] = stripId(child);
  }
  return next;
};

/** Convert a Bun-syntax route path to OpenAPI `{param}` syntax. */
export const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*([A-Za-z0-9_]+)/g, "{$1}");

/** Build the conventional `method_path` operationId. */
export const operationIdFor = (method: string, openApiPath: string): string =>
  `${method.toLowerCase()}_${openApiPath.replace(/[{}/]/g, "_")}`;

/**
 * Derive a management tag from the first path segment, mirroring the
 * `routes/` folder layout: `/api/orders/:id` → `api`, `/auth/login` → `auth`,
 * `/health` → `health`. Root (`/`) falls back to `default`.
 */
export const tagForPath = (openApiPath: string): string =>
  openApiPath.split("/").filter(Boolean)[0] ?? "default";
