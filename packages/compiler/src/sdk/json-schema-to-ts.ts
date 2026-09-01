/**
 * @fileoverview JSON Schema → TypeScript type expression emitter.
 *
 * Converts the JSON Schema objects embedded in an OpenAPI document (request
 * bodies, parameters, responses) into deterministic TypeScript type
 * expressions. Used by the TypeScript SDK platform to give frontend consumers
 * concrete types for request/response payloads.
 *
 * Supported keywords: `type`, `properties`/`required`/`additionalProperties`,
 * `items`/`prefixItems`, `enum`, `const`, `oneOf`/`anyOf`/`allOf`, `nullable`,
 * and local `$ref`s (resolved through the optional `resolveRef` callback).
 * Unknown or unsupported shapes degrade to `unknown` rather than emitting
 * broken types.
 */

/** Options for {@link jsonSchemaToTs}. */
export interface JsonSchemaToTsOptions {
  /** Resolve a `$ref` string to its schema; `undefined` → `unknown`. */
  resolveRef?: (ref: string) => unknown;
  /** Indent unit for multi-line object types. Defaults to two spaces. */
  indent?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Identifier-safe property names stay bare; anything else is quoted. */
const propertyKey = (name: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);

const literal = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** Primitive JSON Schema `type` → TS keyword. */
const primitive = (type: unknown): string => {
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  return "unknown";
};

const asArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

/** Dedupe a union of type expressions while preserving first-seen order. */
const union = (parts: readonly string[]): string => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    if (part === "never") continue;
    if (!seen.has(part)) {
      seen.add(part);
      unique.push(part);
    }
  }
  if (unique.length === 0) return "never";
  return unique.join(" | ");
};

/**
 * Emit the TypeScript type expression for one JSON Schema.
 *
 * @param schema - The JSON Schema value (record or primitive).
 * @param options - Ref resolver + indent configuration.
 * @returns A TS type expression (`string`, `number`, `{ orderId: string }`, …).
 */
export const jsonSchemaToTs = (schema: unknown, options: JsonSchemaToTsOptions = {}): string => {
  const indent = options.indent ?? "  ";
  const resolveRef = options.resolveRef;

  /** Emit one `type` variant; `object`/`array` get their structured forms. */
  const variant = (type: string, value: Record<string, unknown>, depth: number): string => {
    if (type === "object") return emitObject(value, depth);
    if (type === "array") return emitArray(value, depth);
    return primitive(type);
  };

  /** Object-shaped schemas with no explicit `type`. */
  const inferType = (value: Record<string, unknown>, depth: number): string[] => {
    if (isRecord(value.properties) || value.additionalProperties !== undefined) {
      return [emitObject(value, depth)];
    }
    if (isRecord(value.items) || Array.isArray(value.items)) {
      return [emitArray(value, depth)];
    }
    // An empty schema (`{}`) means "any value".
    return ["unknown"];
  };

  const emitArray = (value: Record<string, unknown>, depth: number): string => {
    const prefixItems = asArray(value.prefixItems);
    if (prefixItems !== undefined && prefixItems.length > 0) {
      const rest = value.items !== undefined ? `, ...${emit(value.items, depth)}[]` : "";
      return `[${prefixItems.map((item) => emit(item, depth)).join(", ")}${rest}]`;
    }
    const items = value.items;
    return items !== undefined ? `Array<${emit(items, depth)}>` : "unknown[]";
  };

  /** The object type for a schema with no properties (record or `{}`). */
  const emptyObjectType = (value: Record<string, unknown>, depth: number): string => {
    const ap = value.additionalProperties;
    if (ap === undefined || ap === true) return "Record<string, unknown>";
    return isRecord(ap) ? `Record<string, ${emit(ap, depth)}>` : "Record<string, unknown>";
  };

  /** One property line for an object schema member. */
  const propertyLine = (
    name: string,
    properties: Record<string, unknown>,
    required: Set<string>,
    depth: number,
  ): string => {
    const optional = required.has(name) ? "" : "?";
    return `${indent.repeat(depth + 1)}${propertyKey(name)}${optional}: ${emit(properties[name], depth + 1)};`;
  };

  /** Property lines for an object schema, in declaration order. */
  const propertyLines = (
    names: readonly string[],
    properties: Record<string, unknown>,
    required: Set<string>,
    depth: number,
  ): string[] => names.map((name) => propertyLine(name, properties, required, depth));

  const emitObject = (value: Record<string, unknown>, depth: number): string => {
    const properties = isRecord(value.properties) ? value.properties : {};
    const names = Object.keys(properties);
    const required = new Set<string>(
      Array.isArray(value.required)
        ? value.required.filter((n): n is string => typeof n === "string")
        : [],
    );

    if (names.length === 0) return emptyObjectType(value, depth);

    const lines = propertyLines(names, properties, required, depth);
    if (value.additionalProperties !== undefined) {
      const extra =
        value.additionalProperties === true || !isRecord(value.additionalProperties)
          ? "unknown"
          : emit(value.additionalProperties, depth + 1);
      lines.push(`${indent.repeat(depth + 1)}[key: string]: ${extra};`);
    }
    return `{\n${lines.join("\n")}\n${indent.repeat(depth)}}`;
  };

  /** Merge one `allOf` part's schema bits into the object accumulator. */
  const mergePart = (
    part: unknown,
    properties: Record<string, unknown>,
    required: Set<string>,
    merged: Record<string, unknown>,
  ): void => {
    const record = part as Record<string, unknown>;
    const props = record.properties;
    if (isRecord(props)) {
      for (const key of Object.keys(props)) properties[key] = props[key];
    }
    if (Array.isArray(record.required)) {
      for (const name of record.required) if (typeof name === "string") required.add(name);
    }
    if (record.additionalProperties !== undefined) {
      merged.additionalProperties = record.additionalProperties;
    }
  };

  /** Merge `allOf` object parts (properties + required) into one schema. */
  const mergeObjectParts = (parts: readonly unknown[], depth: number): string => {
    const merged: Record<string, unknown> = { type: "object" };
    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    for (const part of parts) mergePart(part, properties, required, merged);
    merged.properties = properties;
    if (required.size > 0) merged.required = [...required];
    return emit(merged, depth);
  };

  /** `allOf` — merge object parts, intersect everything else. */
  const mergeAllOf = (parts: readonly unknown[], depth: number): string => {
    const objectParts = parts.filter(
      (p) => isRecord(p) && (isRecord(p.properties) || p.type === "object"),
    );
    if (objectParts.length === parts.length && objectParts.length > 0) {
      return mergeObjectParts(objectParts, depth);
    }
    return parts.map((p) => emit(p, depth)).join(" & ") || "unknown";
  };

  /** Dispatch on `type` (string or array) or infer the shape. */
  const emitType = (value: Record<string, unknown>, depth: number): string => {
    const type = value.type;
    const typeParts =
      Array.isArray(type) && type.length > 0
        ? type.map((t) => variant(t, value, depth))
        : typeof type === "string"
          ? [variant(type, value, depth)]
          : inferType(value, depth);

    let emitted = typeParts.length === 1 ? (typeParts[0] ?? "unknown") : union(typeParts);
    if (value.nullable === true) {
      emitted = union([emitted, "null"]);
    }
    return emitted;
  };

  /**
   * `$ref`s currently being expanded. TypeScript cannot express anonymous
   * recursive types, so a cycle (e.g. a tree schema whose `children` items
   * reference their own component) degrades the RECURSIVE POSITION to
   * `unknown` — the surrounding structure stays precise and generation
   * terminates instead of overflowing the stack.
   */
  const activeRefs = new Set<string>();

  /** Hard expansion bound for pathologically nested schemas. */
  const MAX_DEPTH = 64;

  /** Expand one `$ref` with cycle detection (recursive position → unknown). */
  const emitRef = (ref: string, depth: number): string => {
    if (activeRefs.has(ref)) return "unknown";
    const resolved = resolveRef?.(ref);
    if (resolved === undefined) return "unknown";
    activeRefs.add(ref);
    try {
      return emit(resolved, depth);
    } finally {
      activeRefs.delete(ref);
    }
  };

  const emit = (value: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) return "unknown";
    if (!isRecord(value)) {
      // `true` (allow anything) / `false` (allow nothing) boolean schemas.
      return value === true ? "unknown" : "never";
    }

    if (typeof value.$ref === "string") return emitRef(value.$ref, depth);

    if (value.const !== undefined) return literal(value.const);

    const enumValues = asArray(value.enum);
    if (enumValues !== undefined) return union(enumValues.map(literal));

    const variants = asArray(value.oneOf) ?? asArray(value.anyOf);
    if (variants !== undefined && variants.length > 0) {
      return union(variants.map((v) => emit(v, depth)));
    }

    const allOf = asArray(value.allOf);
    if (allOf !== undefined && allOf.length > 0) {
      return mergeAllOf(allOf, depth);
    }

    return emitType(value, depth);
  };

  return emit(schema, 0);
};
