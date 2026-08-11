/**
 * JSON helpers (native-accelerated where proven): validity checks and
 * RFC 6902 JSON Patch.
 */
import { getNative } from "./loader";
import { fromBytes, toBytes } from "./util";

const native = getNative();

/** True when the input is well-formed JSON. */
export const jsonValid = (input: string | Uint8Array): boolean => {
  const bytes = toBytes(input);
  if (native) return native.jsonValid(bytes);
  try {
    JSON.parse(typeof input === "string" ? input : fromBytes(bytes));
    return true;
  } catch {
    return false;
  }
};

// ── JSON Schema validation (native-or-null bridge) ──────────────

export interface SchemaValidator {
  /** `true` when `input` is a JSON document valid against the compiled schema. */
  validate(input: string | Uint8Array): boolean;
  /** Validate a packed batch of JSON documents → number of valid items. */
  validateBatchPackedCount(packed: Uint8Array): number;
}

/**
 * Compile a JSON Schema into a native validator (castrum `SchemaValidator`,
 * backed by `fast_schema` + the `jsonschema` crate).
 *
 * Returns `null` when the Rust addon is unavailable — callers (e.g.
 * `@flux/core` runtime validation) keep their own TS validator (Ajv) as the
 * fallback instead of duplicating a full JSON-Schema engine here. Native
 * validation is proven fastest for large schemas / batch workloads; prefer
 * the TS validator for small one-off documents.
 */
export const createSchemaValidator = (schema: string | Uint8Array): SchemaValidator | null => {
  if (!native) return null;
  const inst = new native.SchemaValidator(toBytes(schema));
  return {
    validate(input) {
      return inst.validate(toBytes(input));
    },
    validateBatchPackedCount(packed) {
      return inst.validateBatchPackedCount(packed);
    },
  };
};

/** Apply an RFC 6902 JSON Patch to a JSON document; returns the patched JSON. */
export const jsonPatch = (doc: string, patch: string): string => {
  if (native) return fromBytes(native.jsonPatch(toBytes(doc), toBytes(patch)));
  return jsonPatchFallback(doc, patch);
};

// ── RFC 6902 fallback ───────────────────────────────────────────

type Json = unknown;

const unescapeToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~");

const parseArrayIndex = (token: string): number | null => {
  if (token === "-") return Number.POSITIVE_INFINITY;
  if (!/^(0|[1-9]\d*)$/.test(token)) return null;
  return Number(token);
};

type Loc = { ok: true; container: Json; key: string | number; exists: boolean } | { ok: false };

/** Resolve the container + key for the final token of a JSON pointer. */
const getParent = (root: Json, tokens: string[]): Loc => {
  let container: Json = root;
  if (tokens.length === 0) return { ok: true, container: root, key: "", exists: true };
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (Array.isArray(container)) {
      const idx = parseArrayIndex(t);
      if (idx == null || idx === Number.POSITIVE_INFINITY || idx >= container.length) {
        return { ok: false };
      }
      container = container[idx]!;
    } else if (container != null && typeof container === "object") {
      const obj = container as Record<string, Json>;
      if (!(t in obj)) return { ok: false };
      container = obj[t]!;
    } else {
      return { ok: false };
    }
  }
  const key = tokens[tokens.length - 1]!;
  if (Array.isArray(container)) {
    const idx = parseArrayIndex(key);
    if (idx == null || idx === Number.POSITIVE_INFINITY || idx > container.length) {
      return { ok: false };
    }
    return { ok: true, container, key: idx, exists: idx < container.length };
  }
  if (container != null && typeof container === "object") {
    const obj = container as Record<string, Json>;
    return { ok: true, container, key, exists: key in obj };
  }
  return { ok: false };
};

const getValue = (root: Json, tokens: string[]): Json | undefined => {
  if (tokens.length === 0) return root;
  const loc = getParent(root, tokens);
  if (!loc.ok || !loc.exists) return undefined;
  const container = loc.container as Record<string | number, Json>;
  return container[loc.key];
};

const deepEqual = (a: Json, b: Json): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    a != null &&
    b != null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ak = Object.keys(a as Record<string, Json>);
    const bk = Object.keys(b as Record<string, Json>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, Json>)[k], (b as Record<string, Json>)[k]),
    );
  }
  return false;
};

const addValue = (loc: Extract<Loc, { ok: true }>, value: Json): void => {
  const container = loc.container as Record<string | number, Json>;
  if (Array.isArray(loc.container)) {
    const arr = loc.container as Json[];
    if (loc.key === Number.POSITIVE_INFINITY) {
      arr.push(value);
    } else {
      arr.splice(loc.key as number, 0, value);
    }
  } else {
    container[loc.key] = value;
  }
};

const removeValue = (loc: Extract<Loc, { ok: true }>): void => {
  const container = loc.container as Record<string | number, Json>;
  if (Array.isArray(loc.container)) {
    (loc.container as Json[]).splice(loc.key as number, 1);
  } else {
    delete container[loc.key];
  }
};

/** Minimal RFC 6902 implementation (add/remove/replace/test/move/copy). */
export const jsonPatchFallback = (doc: string, patch: string): string => {
  const root: Json = JSON.parse(doc);
  const ops = JSON.parse(patch) as Array<Record<string, Json>>;

  for (const op of ops) {
    const kind = String(op.op);
    const path = String(op.path);
    const tokens = path === "" ? [] : path.replace(/^\//, "").split("/").map(unescapeToken);

    switch (kind) {
      case "add": {
        const loc = getParent(root, tokens);
        if (!loc.ok || tokens.length === 0) throw new Error(`jsonPatch: bad add path '${path}'`);
        addValue(loc, op.value);
        break;
      }
      case "remove": {
        const loc = getParent(root, tokens);
        if (!loc.ok || !loc.exists || tokens.length === 0) {
          throw new Error(`jsonPatch: bad remove path '${path}'`);
        }
        removeValue(loc);
        break;
      }
      case "replace": {
        const loc = getParent(root, tokens);
        if (!loc.ok || !loc.exists || tokens.length === 0) {
          throw new Error(`jsonPatch: bad replace path '${path}'`);
        }
        (loc.container as Record<string | number, Json>)[loc.key] = op.value;
        break;
      }
      case "test": {
        const current = getValue(root, tokens);
        if (!deepEqual(current, op.value)) {
          throw new Error(`jsonPatch: test failed at '${path}'`);
        }
        break;
      }
      case "move": {
        const from = String(op.from ?? "");
        const fromTokens = from === "" ? [] : from.replace(/^\//, "").split("/").map(unescapeToken);
        const value = getValue(root, fromTokens);
        const fromLoc = getParent(root, fromTokens);
        if (value === undefined || !fromLoc.ok || !fromLoc.exists || fromTokens.length === 0) {
          throw new Error(`jsonPatch: bad move from '${from}'`);
        }
        removeValue(fromLoc);
        const toLoc = getParent(root, tokens);
        if (!toLoc.ok || tokens.length === 0) throw new Error(`jsonPatch: bad move path '${path}'`);
        addValue(toLoc, value);
        break;
      }
      case "copy": {
        const from = String(op.from ?? "");
        const fromTokens = from === "" ? [] : from.replace(/^\//, "").split("/").map(unescapeToken);
        const value = getValue(root, fromTokens);
        if (value === undefined) throw new Error(`jsonPatch: bad copy from '${from}'`);
        const toLoc = getParent(root, tokens);
        if (!toLoc.ok || tokens.length === 0) throw new Error(`jsonPatch: bad copy path '${path}'`);
        addValue(toLoc, structuredClone(value));
        break;
      }
      default:
        throw new Error(`jsonPatch: unsupported op '${kind}'`);
    }
  }

  return JSON.stringify(root);
};
