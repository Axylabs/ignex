/**
 * Shared wire-format constants. These are the SINGLE source of truth for the
 * transport envelope — every emitter (TS registry, Rust glue, direct serde)
 * imports them so the TS and Rust sides stay in sync by construction.
 *
 * The Rust `fb_wire_version()` export is checked against `WIRE_VERSION` at
 * bind time (`src/native/ffi.ts`) to catch any drift between a stale cdylib
 * and the generated artifacts.
 */

/** Wire format version. Bump on any BREAKING envelope change. */
export const WIRE_VERSION = 1;

/**
 * Envelope header length in bytes: `[version:1][event_id:u32 LE]`. The
 * size-prefixed FlatBuffer payload follows immediately after.
 */
export const WIRE_HEADER_LEN = 5;
