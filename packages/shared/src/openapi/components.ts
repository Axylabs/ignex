/**
 * @fileoverview OpenAPI components — `$defs` hoisting into
 * `components.schemas` and the derived top-level `tags` array.
 */

import { isRecord } from "./schema";

type SchemaRegistry = Record<string, unknown>;

/**
 * Hoist `$defs` into `components.schemas` and rewrite `#/$defs/<name>` refs
 * to `#/components/schemas/<name>` (the OpenAPI tooling convention). Runs over
 * the finished document so nested `$defs` from TypeBox/JSON Schema are
 * collected once and de-duplicated by name (first wins).
 */
const hoistDefs = (value: unknown, schemas: SchemaRegistry): unknown => {
  if (Array.isArray(value)) return value.map((item) => hoistDefs(item, schemas));
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$defs" && isRecord(child)) {
      for (const [name, def] of Object.entries(child)) {
        schemas[name] ??= def;
      }
      continue;
    }
    if (key === "$ref" && typeof child === "string") {
      const ref = /^#\/\$defs\/(.+)$/.exec(child);
      if (ref) {
        next[key] = `#/components/schemas/${ref[1]}`;
        continue;
      }
    }
    next[key] = hoistDefs(child, schemas);
  }
  return next;
};

/**
 * Collect every tag used across the document's operations into a sorted,
 * de-duplicated top-level `tags` array (`[{ name }]`). Explicit `detail.tags`
 * and auto-derived path tags both land here, so docs UIs render the groups.
 */
const collectTags = (
  paths: Record<string, Record<string, Record<string, unknown>>>,
): Array<{ name: string; description?: string }> => {
  const byName = new Map<string, { name: string; description?: string }>();
  for (const methods of Object.values(paths)) {
    for (const operation of Object.values(methods)) {
      const tags = operation.tags;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        if (typeof tag !== "string" || tag.length === 0) continue;
        if (byName.has(tag)) continue;
        byName.set(tag, { name: tag });
      }
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** The document state threaded through the pipeline stages. */
export interface DocState {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: SchemaRegistry };
}

/** Hoist `$defs` in every operation into a shared `components.schemas`. */
export const hoistComponents = (paths: DocState["paths"]): DocState => {
  const schemas: SchemaRegistry = {};
  const hoisted: DocState["paths"] = {};
  for (const [openApiPath, methods] of Object.entries(paths)) {
    const next: Record<string, Record<string, unknown>> = {};
    for (const [method, operation] of Object.entries(methods)) {
      next[method] = hoistDefs(operation, schemas) as Record<string, unknown>;
    }
    hoisted[openApiPath] = next;
  }
  return { paths: hoisted, components: { schemas } };
};

/** The derived `tags` array for the document (see {@link collectTags}). */
export const collectDocumentTags = collectTags;
