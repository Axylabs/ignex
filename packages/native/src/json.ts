/**
 * JSON helpers (native-accelerated where proven): validity checks and
 * RFC 6902 JSON Patch.
 */
import { applyPatch, type Operation } from "fast-json-patch";
import { createAdaptiveExecutor } from "./adaptive";
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

const jsonValidExecution = createAdaptiveExecutor({
  enabled: process.env.IGNEX_ADAPTIVE !== "off" && process.env.IGNEX_SIZE_GATES !== "off",
  sizeBuckets: [255, 4096, 65_536],
  initialImpl: (bytes) => (sizeGateAllowsNative("jsonValid", bytes) ? "castrum" : "js"),
  nativeAvailable: () => nativeFor("jsonValid") !== null,
});

/** True when the input is well-formed JSON. */
export const jsonValid = (input: string | Uint8Array): boolean => {
  const bytes = toBytes(input);
  const choice = jsonValidExecution.choose(bytes.length);
  if (choice === false) return jsonValidJs(input, bytes);
  if (choice === true) {
    return nativeFor("jsonValid")?.jsonValid(bytes) ?? jsonValidJs(input, bytes);
  }
  try {
    return choice.impl === "castrum"
      ? (nativeFor("jsonValid")?.jsonValid(bytes) ?? jsonValidJs(input, bytes))
      : jsonValidJs(input, bytes);
  } finally {
    jsonValidExecution.record(choice);
  }
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

/** Apply RFC 6902 operations with validation and prototype-pollution protection. */
export const jsonPatchFallback = (doc: string, patch: string): string => {
  const root = JSON.parse(doc) as unknown;
  const operations = JSON.parse(patch) as Operation[];
  return JSON.stringify(applyPatch(root, operations, true, true, true).newDocument);
};
