/**
 * JSON helpers (native-accelerated where proven): validity checks and
 * RFC 6902 JSON Patch.
 */
import { getFfiInstances } from "./ffi";
import { nativeFor } from "./runtime";
import { sizeGateAllowsNative } from "./selection";
import { fromBytes, toBytes } from "./util";

const jsonValidJs = (input: string | Uint8Array, bytes: Uint8Array): boolean => {
  try {
    JSON.parse(typeof input === "string" ? input : fromBytes(bytes));
    return true;
  } catch {
    return false;
  }
};

/** True when the input is well-formed JSON. */
export const jsonValid = (input: string | Uint8Array): boolean => {
  const bytes = toBytes(input);
  // Size-gated dispatch (measured crossover — see SIZE_GATES): tiny inputs
  // lose to the boundary/transcode cost, so JSON.parse takes them; larger
  // inputs amortize it and go native.
  if (sizeGateAllowsNative("jsonValid", bytes.length)) {
    const n = nativeFor("jsonValid");
    if (n) return n.jsonValid(bytes);
  }
  return jsonValidJs(input, bytes);
};

// ── JSON Schema validation (native-or-null bridge) ──────────────

/** Compiled native JSON-Schema validator (validates, batches, and derives). */
export interface SchemaValidator {
  /** Opaque C-ABI handle for fused wire-level ops (0 = unavailable). */
  innerHandle?: number;
  /** `true` when `input` is a JSON document valid against the compiled schema. */
  validate(input: string | Uint8Array): boolean;
  /** Validate a packed batch of JSON documents → number of valid items. */
  validateBatchPackedCount(packed: Uint8Array): number;
  /**
   * One-pass validate + extract: validate `input` against the schema and
   * capture scalar values / array lengths at `paths` during the same native
   * walk (no `JSON.parse`, no DOM). For "derive" routes (response built from a
   * handful of body fields) this replaces `JSON.parse` + Ajv on the happy path
   * and rejects invalid bodies with zero DOM/GC.
   *
   * `paths` are RFC 6901 JSON pointers of OBJECT KEYS; a trailing `/-`
   * captures the ARRAY LENGTH at that path (e.g. `"/totalCents"`,
   * `"/lineItems/-"`). Array-index steps are not supported.
   */
  derive(input: string | Uint8Array, paths: string[]): JsonDeriveResult | null;
}

/** A single derived value captured during one-pass validation. */
export interface JsonDeriveValue {
  /** `"int" | "number" | "string" | "bool" | "null"`. */
  kind: string;
  int: number | null;
  number: number | null;
  text: string | null;
  boolean: boolean | null;
}

/** Result of a one-pass `validate + derive`. */
export interface JsonDeriveResult {
  /** `true` when the document is schema-valid; `false` → caller rejects. */
  ok: boolean;
  /** One entry per requested path (`null` = path absent from the document). */
  values: Array<JsonDeriveValue | null>;
}

/**
 * Compile a JSON Schema into a native validator (castrum `SchemaValidator`,
 * backed by `fast_schema` + the `jsonschema` crate).
 *
 * Returns `null` when the Rust addon is unavailable — callers (e.g.
 * `@ignex/core` runtime validation) keep their own TS validator (Ajv) as the
 * fallback instead of duplicating a full JSON-Schema engine here. Native
 * validation is proven fastest for large schemas / batch workloads; prefer
 * the TS validator for small one-off documents.
 */
export const createSchemaValidator = (schema: string | Uint8Array): SchemaValidator | null => {
  const n = nativeFor("createSchemaValidator");
  if (!n) return null;
  const inst = new n.SchemaValidator(toBytes(schema));
  // Opaque-handle C-ABI fast path — the per-call `validate` crossing drops from
  // ~310ns (NAPI) to ~80ns (C-ABI) on the compiled instance (bench 2026-08-16;
  // null handle → NAPI fallback).
  const ffiInst = getFfiInstances();
  const inner = ffiInst ? Number(inst.innerPtr()) : 0;
  return {
    /** Opaque C-ABI handle (0 = unavailable) for fused wire-level ops. */
    innerHandle: inner,
    validate(input) {
      if (inner && ffiInst) return ffiInst.schemaValidatorValidate(inner, toBytes(input));
      return inst.validate(toBytes(input));
    },
    validateBatchPackedCount(packed) {
      return inst.validateBatchPackedCount(packed);
    },
    derive(input, paths) {
      const r = inst.derive(toBytes(input), paths);
      return r ? { ok: r.ok, values: r.values } : null;
    },
  };
};

/** Apply an RFC 6902 JSON Patch to a JSON document; returns the patched JSON. */
export const jsonPatch = (doc: string, patch: string): string => {
  const n = nativeFor("jsonPatch");
  if (n) return fromBytes(n.jsonPatch(toBytes(doc), toBytes(patch)));
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

/** Advance one JSON-pointer token into the current container (`undefined` = miss). */
const descend = (container: Json, token: string): Json | undefined => {
  if (Array.isArray(container)) {
    const idx = parseArrayIndex(token);
    if (idx == null || idx === Number.POSITIVE_INFINITY || idx >= container.length) {
      return undefined;
    }
    return container[idx];
  }
  if (container != null && typeof container === "object") {
    const obj = container as Record<string, Json>;
    if (!(token in obj)) return undefined;
    return obj[token];
  }
  return undefined;
};

/** Resolve the container + key for the final token of a JSON pointer. */
const getParent = (root: Json, tokens: string[]): Loc => {
  let container: Json = root;
  if (tokens.length === 0) return { ok: true, container: root, key: "", exists: true };
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t === undefined) return { ok: false };
    const next = descend(container, t);
    if (next === undefined) return { ok: false };
    container = next;
  }
  const key = tokens[tokens.length - 1];
  if (key === undefined) return { ok: false };
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

const splitTokens = (path: string): string[] =>
  path === "" ? [] : path.replace(/^\//, "").split("/").map(unescapeToken);

const applyAdd = (root: Json, tokens: string[], value: Json, path: string): void => {
  const loc = getParent(root, tokens);
  if (!loc.ok || tokens.length === 0) throw new Error(`jsonPatch: bad add path '${path}'`);
  addValue(loc, value);
};

const applyRemove = (root: Json, tokens: string[], path: string): void => {
  const loc = getParent(root, tokens);
  if (!loc.ok || !loc.exists || tokens.length === 0) {
    throw new Error(`jsonPatch: bad remove path '${path}'`);
  }
  removeValue(loc);
};

const applyReplace = (root: Json, tokens: string[], value: Json, path: string): void => {
  const loc = getParent(root, tokens);
  if (!loc.ok || !loc.exists || tokens.length === 0) {
    throw new Error(`jsonPatch: bad replace path '${path}'`);
  }
  (loc.container as Record<string | number, Json>)[loc.key] = value;
};

const applyTest = (root: Json, tokens: string[], value: Json, path: string): void => {
  const current = getValue(root, tokens);
  if (!deepEqual(current, value)) {
    throw new Error(`jsonPatch: test failed at '${path}'`);
  }
};

const applyMove = (root: Json, tokens: string[], op: Record<string, Json>, path: string): void => {
  const from = String(op.from ?? "");
  const fromTokens = splitTokens(from);
  const value = getValue(root, fromTokens);
  const fromLoc = getParent(root, fromTokens);
  if (value === undefined || !fromLoc.ok || !fromLoc.exists || fromTokens.length === 0) {
    throw new Error(`jsonPatch: bad move from '${from}'`);
  }
  removeValue(fromLoc);
  const toLoc = getParent(root, tokens);
  if (!toLoc.ok || tokens.length === 0) throw new Error(`jsonPatch: bad move path '${path}'`);
  addValue(toLoc, value);
};

const applyCopy = (root: Json, tokens: string[], op: Record<string, Json>, path: string): void => {
  const from = String(op.from ?? "");
  const fromTokens = splitTokens(from);
  const value = getValue(root, fromTokens);
  if (value === undefined) throw new Error(`jsonPatch: bad copy from '${from}'`);
  const toLoc = getParent(root, tokens);
  if (!toLoc.ok || tokens.length === 0) throw new Error(`jsonPatch: bad copy path '${path}'`);
  addValue(toLoc, structuredClone(value));
};

/** Minimal RFC 6902 implementation (add/remove/replace/test/move/copy). */
export const jsonPatchFallback = (doc: string, patch: string): string => {
  const root: Json = JSON.parse(doc);
  const ops = JSON.parse(patch) as Array<Record<string, Json>>;

  for (const op of ops) {
    const kind = String(op.op);
    const path = String(op.path);
    const tokens = splitTokens(path);

    switch (kind) {
      case "add":
        applyAdd(root, tokens, op.value, path);
        break;
      case "remove":
        applyRemove(root, tokens, path);
        break;
      case "replace":
        applyReplace(root, tokens, op.value, path);
        break;
      case "test":
        applyTest(root, tokens, op.value, path);
        break;
      case "move":
        applyMove(root, tokens, op, path);
        break;
      case "copy":
        applyCopy(root, tokens, op, path);
        break;
      default:
        throw new Error(`jsonPatch: unsupported op '${kind}'`);
    }
  }

  return JSON.stringify(root);
};
