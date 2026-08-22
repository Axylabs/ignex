/**
 * Runtime `Bindings` — the per-schema bundle that decouples the transport from
 * ANY particular event registry.
 *
 * Today the transport modules import the repo's generated artifacts directly
 * (`src/generated/registry`, `src/generated/ts-ser`, `src/generated/direct-ser`
 * and `src/schema`). `Bindings` is the generic contract: every schema-specific
 * piece of the wire stack (event ids, decoders, encoders, direct fast-path
 * tables, schema metadata) is grouped into one object, and the server / client /
 * NATS bridge accept it via `options.bindings` (defaulting to the built-in
 * registry, so existing code keeps working unchanged).
 *
 * Two ways to obtain a `Bindings`:
 *   - the built-in one: `defaultBindings` (see `src/bindings/default.ts`)
 *   - your own schema: run `generateBindings(schema)` (public/generate.ts),
 *     then assemble the emitted parts with `assembleBindings`
 *     (src/bindings/assemble.ts). Everything else — encode, decode, NATS
 *     subject naming, server/client APIs — is then typed against YOUR events.
 */
import type { Static, TSchema } from "@sinclair/typebox";

/** Direct fast-path call signature (generated `direct-ser.ts`). */
export type DirectCall = (...args: unknown[]) => number;

/** Generated zero-alloc encoder: fields → FFI args → out buffer. */
export type DirectEncoder = (call: DirectCall, o: unknown, out: Uint8Array) => number;

/**
 * The generated direct fast-path tables (Bun server only). Absent when the
 * schema has no directable events or the codegen was run with `rust: false`.
 */
export interface DirectTables {
  /** dlopen specs in canonical form (see `src/native/ffi.ts` `abi()`). */
  readonly symbols: Readonly<Record<string, { args: readonly string[]; returns: string }>>;
  /** event → FFI symbol name. */
  readonly symbolNames: Readonly<Record<string, string>>;
  /** event → zero-alloc encoder. */
  readonly encoders: Readonly<Record<string, DirectEncoder>>;
  /** event → NUL pre-scan (true routes the payload to the JSON path). */
  readonly hasNul: Readonly<Record<string, (o: unknown) => boolean>>;
  /** bind-time per-symbol self-test; returns the symbol names to DISABLE. */
  readonly selfTest: (
    raw: Record<string, (...args: unknown[]) => number>,
    scratch: Uint8Array,
  ) => string[];
}

/**
 * The complete per-schema wire stack. `events` / `controlEvents` are the
 * TypeBox schemas — from them consumers derive `EventNameOf` / `EventsOf`.
 */
export interface Bindings {
  /** wire envelope version (see `scripts/constants.ts`). */
  readonly wireVersion: number;
  /** envelope header bytes: `[version:1][event_id:u32 LE]`. */
  readonly wireHeaderLen: number;
  /**
   * Stable schema fingerprint (FNV-1a 32 over the canonical model). The Rust
   * cdylib exports the same value (`fb_schema_fingerprint`), so a schema-
   * mismatched addon fails the bind-time self-test instead of producing
   * undecodable frames.
   */
  readonly schemaFingerprint: number;
  /** NATS subject prefix used by bridges built from these bindings. */
  readonly subjectPrefix?: string;
  /**
   * "required" — the Rust addon must exist and pass self-tests (the built-in
   * registry: a missing addon throws). "optional" — generated for user
   * schemas: the addon is used when `IGNEX_FFI_PATH` is set and passes
   * self-tests; otherwise the pure-JS encoder is used (works without Rust).
   */
  readonly ffiMode: "required" | "optional";
  /** app event schemas (name → TypeBox). */
  readonly events: Readonly<Record<string, TSchema>>;
  /** control event schemas (name → TypeBox). */
  readonly controlEvents: Readonly<Record<string, TSchema>>;

  // ── event id maps (stable FNV-1a 32 over the name) ────────────────────
  readonly eventNameToId: Readonly<Record<string, number>>;
  readonly idToEventName: Readonly<Record<number, string>>;
  /** merged app + control maps (encode dispatch). */
  readonly anyEventNameToId: Readonly<Record<string, number>>;
  readonly idToAnyEventName: Readonly<Record<number, string>>;
  readonly controlIds: ReadonlySet<number>;

  // ── wire helpers (pure — run in browser + Bun) ────────────────────────
  readFrameHeader(bytes: Uint8Array): { name: string; id: number } | null;
  isControlId(id: number): boolean;
  decodePayload(id: number, bytes: Uint8Array): unknown;
  decodeFrame(bytes: Uint8Array): { name: string; id: number; payload: unknown } | null;

  /** Pure-JS encoder: plain object → full wire frame. Works everywhere. */
  encodeFrame(name: string, payload: unknown): Uint8Array;

  /** Generated direct fast-path tables (optional — server only). */
  readonly direct?: DirectTables;
}

// ── type-level derivation from a concrete Bindings ────────────────────────

export type EventNameOf<B extends Bindings> = Extract<keyof B["events"], string>;
export type ControlEventNameOf<B extends Bindings> = Extract<keyof B["controlEvents"], string>;

/** Plain-object payload map derived from a bindings' TypeBox schemas. */
export type EventsOf<B extends Bindings> = {
  [K in EventNameOf<B>]: Static<B["events"][K]>;
};
export type ControlEventsOf<B extends Bindings> = {
  [K in ControlEventNameOf<B>]: Static<B["controlEvents"][K]>;
};

/** The built-in registry's bindings type (see `src/bindings/default.ts`). */
export type DefaultBindings = typeof import("./default").defaultBindings;
