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
 * Namespace segments — they name the API's shape, not a resource. Dropping
 * them is what keeps a namespaced app (`/api/…`, `/api/v1/…`) from collapsing
 * into ONE tag in docs UIs, which is the whole point of auto-tagging.
 */
const GENERIC_SEGMENTS = new Set(["api", "rest", "graphql", "rpc"]);

/** Version-ish namespace segments (`v1`, `v2.1`, `v10`) — same reasoning. */
const VERSION_SEGMENT = /^v\d+(?:[._-]\d+)*$/i;

/** Path-parameter segments (`{id}`, `{path}`) — never a group of their own. */
const PARAM_SEGMENT = /^\{/;

/** True when a segment names a resource/group rather than a namespace. */
const isGroupingSegment = (segment: string): boolean =>
  !GENERIC_SEGMENTS.has(segment.toLowerCase()) &&
  !VERSION_SEGMENT.test(segment) &&
  !PARAM_SEGMENT.test(segment);

/** The non-empty segments of an OpenAPI path. */
const segmentsOf = (openApiPath: string): readonly string[] =>
  openApiPath.split("/").filter(Boolean);

/**
 * Derive a management tag from the route path, mirroring the `routes/` folder
 * layout: `/api/orders/:id` → `orders`, `/auth/login` → `auth`, `/health` →
 * `health`.
 *
 * Namespace segments are skipped, so a versioned/namespaced app still groups
 * per resource: `/api/orders` → `orders`, `/api/v1/users/:id` → `users`.
 * A path made only of namespaces (`/api`) falls back to `default`.
 */
export const tagForPath = (openApiPath: string): string =>
  segmentsOf(openApiPath).find(isGroupingSegment) ?? "default";

/**
 * The path prefix the auto tag was derived from — `/api/orders/{id}` →
 * `/api/orders`. Used for the tag's `description`, so docs UIs say what each
 * group covers. Empty string when the path has no grouping segment.
 */
export const tagPrefixForPath = (openApiPath: string): string => {
  const segments = segmentsOf(openApiPath);
  const index = segments.findIndex(isGroupingSegment);
  return index < 0 ? "" : `/${segments.slice(0, index + 1).join("/")}`;
};
