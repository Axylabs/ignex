//! ignex-nova FFI cdylib.
//!
//! Layout:
//!   - `generated/`   — flatc `--rust` output (written by `scripts/generate.ts`)
//!   - `transcode/`   — generated JSON→FlatBuffer glue (same generator)
//!   - `ffi.rs`       — `#[no_mangle] extern "C"` surface consumed by Bun `dlopen`
pub mod ffi;
pub mod generated;
pub mod transcode;
