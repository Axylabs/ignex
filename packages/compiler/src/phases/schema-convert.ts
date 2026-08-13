/**
 * Build-time Standard-Schema → JSON Schema conversion.
 *
 * `StandardSchemaV1` objects only guarantee a `validate` function, so a
 * JSON-schema representation is not always available. We try, in order:
 *
 *  1. a `toJSONSchema`/`toJsonSchema` method on the schema object itself
 *     (ArkType and other type objects that attach `~standard` directly), and
 *  2. vendor-specific lazy converters (`zod-to-json-schema`, `valibot`) —
 *     dynamically imported only when the vendor package is installed, so no
 *     hard dependency is added here.
 *
 * When neither is available the part is left untouched and the caller falls
 * back to runtime validation/serialization (emitting `IGN_STANDARD_SCHEMA_
 * RUNTIME`). Conversion is best-effort: failures degrade safely.
 */

type JsonSchema = Record<string, unknown>;

const isStandardSchema = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "~standard" in value;

/** Convert via a `toJSONSchema`/`toJsonSchema` method on the schema itself. */
const convertViaSelfMethod = async (schema: unknown): Promise<JsonSchema | null> => {
  const self = schema as { toJSONSchema?: unknown; toJsonSchema?: unknown };
  for (const method of ["toJSONSchema", "toJsonSchema"] as const) {
    const fn = self[method];
    if (typeof fn === "function") {
      try {
        const out = (fn as () => unknown).call(self);
        if (out && typeof out === "object") return out as JsonSchema;
      } catch {
        // Fall through to vendor converters.
      }
    }
  }
  return null;
};

/** Convert a Zod schema via `zod-to-json-schema` (lazily imported). */
const convertZod = async (schema: unknown): Promise<JsonSchema | null> => {
  const specifier = "zod-to-json-schema";
  const mod: any = await import(specifier);
  const converter = mod.zodToJsonSchema ?? mod.default?.zodToJsonSchema ?? mod.default;
  if (typeof converter === "function") {
    const out = converter(schema);
    if (out && typeof out === "object") return out as JsonSchema;
  }
  return null;
};

/** Convert a Valibot schema (lazily imported). */
const convertValibot = async (schema: unknown): Promise<JsonSchema | null> => {
  const specifier = "valibot";
  const mod: any = await import(specifier);
  if (typeof mod.toJsonSchema === "function") {
    const out = mod.toJsonSchema(schema);
    if (out && typeof out === "object") return out as JsonSchema;
  }
  return null;
};

/** Convert via the schema's vendor-specific lazy converter. */
const convertVendor = async (schema: unknown): Promise<JsonSchema | null> => {
  const std = schema as { "~standard"?: { vendor?: string } };
  const vendor = std["~standard"]?.vendor ?? "";
  if (vendor === "zod") return convertZod(schema);
  if (vendor === "valibot") return convertValibot(schema);
  return null;
};

/** Convert a single Standard-Schema object, or return `null` when impossible. */
const convertOne = async (schema: unknown): Promise<JsonSchema | null> => {
  if (!isStandardSchema(schema)) return null;

  // 1) The schema object itself exposes a JSON-schema converter.
  const viaSelf = await convertViaSelfMethod(schema);
  if (viaSelf) return viaSelf;

  // 2) Vendor-specific lazy converters. The specifier is a variable so tsc
  // does not resolve it — these packages are optional peer installs.
  try {
    return await convertVendor(schema);
  } catch {
    return null;
  }
};

const STATUS_KEY = /^\d{3}$/;

/**
 * Convert the `response` part of a schema document: a single Standard-Schema
 * or a `{ "200": schema, ... }` status map. Returns the replacement value,
 * or `undefined` when nothing changed (caller keeps the original).
 */
const convertResponse = async (response: unknown): Promise<Record<string, unknown> | undefined> => {
  if (!response || typeof response !== "object") return undefined;

  if (isStandardSchema(response)) {
    const converted = await convertOne(response);
    return converted ?? undefined;
  }

  const statusMap = response as Record<string, unknown>;
  const keys = Object.keys(statusMap);
  if (keys.length === 0 || !keys.every((k) => STATUS_KEY.test(k))) return undefined;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const status of keys) {
    const value = statusMap[status];
    if (isStandardSchema(value)) {
      const converted = await convertOne(value);
      next[status] = converted ?? value;
      changed = changed || converted !== null;
    } else {
      next[status] = value;
    }
  }
  return changed ? next : undefined;
};

/**
 * Convert the Standard-Schema parts of a route schema document (body, query,
 * params, headers, cookie, and a `response` that is either a single schema or
 * a status map) into plain JSON Schema. Non-Standard parts pass through
 * unchanged; unconvertible parts stay as-is so callers can fall back.
 */
export const convertSchemaDoc = async (
  schemaDoc: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = { ...schemaDoc };

  const convertSingle = async (key: string, value: unknown): Promise<void> => {
    if (!value || typeof value !== "object") return;
    if (!isStandardSchema(value)) return;

    const converted = await convertOne(value);
    if (converted) out[key] = converted;
  };

  for (const key of ["body", "query", "params", "headers", "cookie"]) {
    await convertSingle(key, out[key]);
  }

  // Response: either a single schema or a `{ "200": schema, ... }` status map.
  const nextResponse = await convertResponse(out.response);
  if (nextResponse !== undefined) out.response = nextResponse;

  return out;
};
