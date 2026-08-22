//! C-ABI surface for Bun `dlopen`. Conventions follow the castrum FFI guide:
//!   - `panic_guard` every call (a panic unwinding through `extern "C"` kills Bun)
//!   - null-check every pointer
//!   - `cstring` ARG → `CStr::from_ptr` (Bun's engine transcodes the JS string;
//!     zero JS-side text encoding — the "cstring zero text encoding" pattern)
//!   - needed-size convention: `0` = error, `w > out_cap` = exact size required
//!   - `thread_local` scratch only (no global `static mut`)
//!
//! Frame envelope (written by both `fb_serialize` and the generated direct
//! `fb_*_serialize` exports):
//!   `[WIRE_VERSION:1][event_id:u32 LE][size-prefixed FlatBuffer]`
//!
//! Bun binding (`src/native/ffi.ts`):
//!   fb_serialize:     { args: ['u32','cstring','buffer','buffer_length'], returns: 'u64_fast' }
//!   fb_probe:         { args: [], returns: 'u32' }
//!   fb_wire_version:  { args: [], returns: 'u32' }
use std::ffi::CStr;
use std::os::raw::c_char;

use crate::transcode::generated::{self, WIRE_HEADER_LEN, WIRE_VERSION};

/// Bind-time self-test / capability probe magic ("IGNX").
pub const FB_PROBE_MAGIC: u32 = 0x4947_4e58;

/// Capability probe used by the Bun bind-time self-test.
#[no_mangle]
pub unsafe extern "C" fn fb_probe() -> u32 {
    FB_PROBE_MAGIC
}

/// Wire-format version. Checked against the TS `WIRE_VERSION` at bind time so a
/// stale cdylib (built from an older schema/envelope) fails loudly instead of
/// silently producing frames the client can't decode.
#[no_mangle]
pub extern "C" fn fb_wire_version() -> u32 {
    WIRE_VERSION as u32
}

/// Schema fingerprint (FNV-1a 32 over the canonical model). The Bun side
/// checks it against the generated `SCHEMA_FINGERPRINT` at bind time, so a
/// cdylib built from a DIFFERENT schema (e.g. pointing `IGNEX_FFI_PATH` at the
/// built-in addon from a project with its own generated bindings) fails loudly
/// instead of producing frames the client can't decode.
#[no_mangle]
pub extern "C" fn fb_schema_fingerprint() -> u64 {
    generated::SCHEMA_FINGERPRINT
}

// ── Diagnostic C-ABI probes (bench-only, NOT in the ffi.ts dlopen map) ─────
//
// Used ONLY by bench/ffi-margin.ts to isolate the fixed per-call FFI cost into
// its components (mirrors castrum's `ffi_probe_*` set): the bare trampoline
// (noop), scalar-arg/return conversion (echo_usize), TypedArray-view→pointer
// resolution (echo_view), and `cstring`-ARG transcoding (echo_cstr — the engine
// encodes the JS string to a call-scoped NUL-terminated buffer; the callee
// borrows via `CStr::from_ptr`, never dereferencing beyond NUL). They are
// trivial, non-fallible, allocate nothing, and are NOT part of the shipped
// `src/native/ffi.ts` dlopen map.

/// Bare C-ABI trampoline floor: does nothing, returns nothing.
#[no_mangle]
pub extern "C" fn ffi_probe_noop() {}

/// Scalar pass-through: returns `v` unchanged. Measures scalar-arg + return
/// conversion only (bind with `usize` vs `u64_fast` to isolate BigInt boxing).
#[no_mangle]
pub extern "C" fn ffi_probe_echo_usize(v: usize) -> usize {
    v
}

/// View pass-through: returns the byte length of the `(ptr, len)` pair.
/// Measures TypedArray-view→pointer resolution + (ptr,len) arg conversion.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes (the pointer is only used to
/// form a slice whose length we return — never dereferenced).
#[no_mangle]
pub unsafe extern "C" fn ffi_probe_echo_view(data: *const u8, len: usize) -> usize {
    if data.is_null() && len != 0 {
        return 0;
    }
    let _ = std::slice::from_raw_parts(data, len);
    len
}

/// `cstring`-ARG pass-through: returns the byte length of the NUL-terminated
/// C string the engine produced by transcoding a JS string arg. Measures the
/// engine-side JS-string→UTF-8 transcode + call-scoped buffer + callee
/// `CStr::from_ptr` borrow — the cost a `'cstring'` input arg adds compared
/// with a JS-side encode + `(ptr,len)` pair. The pointer is only used to
/// form a slice whose length we return — never dereferenced beyond NUL.
///
/// # Safety
/// `data` must be a valid NUL-terminated C string for reads up to its terminator.
#[no_mangle]
pub unsafe extern "C" fn ffi_probe_echo_cstr(data: *const c_char) -> usize {
    if data.is_null() {
        return 0;
    }
    CStr::from_ptr(data).to_bytes().len()
}

/// Serialize a JS object (JSON text) into the transport frame
/// `[WIRE_VERSION][event_id:u32][size-prefixed FlatBuffer]`, writing into `out`.
///
/// Returns (`u64_fast` on the Bun side):
///   - `0`             → hard error (bad JSON / unknown event id / panic)
///   - `w <= out_cap`  → `w` bytes written (envelope + flatbuffer)
///   - `w > out_cap`   → exactly `w` bytes required; nothing written
///
/// `json` is a NUL-terminated UTF-8 C string (Bun `cstring` arg).
///
/// # Safety
/// `json` must point to a NUL-terminated UTF-8 buffer valid for the call.
/// `out` must point to `out_cap` writable bytes (or be null when `out_cap == 0`).
#[no_mangle]
pub unsafe extern "C" fn fb_serialize(event_id: u32, json: *const c_char, out: *mut u8, out_cap: usize) -> usize {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if json.is_null() || (out.is_null() && out_cap != 0) {
            return 0;
        }
        let json_bytes = CStr::from_ptr(json).to_bytes();
        // envelope = [WIRE_VERSION:1][event_id:u32 LE]; flatbuffer payload follows
        let payload: &mut [u8] = if out_cap < WIRE_HEADER_LEN {
            &mut []
        } else {
            std::slice::from_raw_parts_mut(out.add(WIRE_HEADER_LEN), out_cap - WIRE_HEADER_LEN)
        };
        match generated::serialize_event(event_id, json_bytes, payload) {
            Ok(written) => {
                let needed = written + WIRE_HEADER_LEN;
                if needed <= out_cap {
                    *out.add(0) = WIRE_VERSION;
                    let id_bytes = event_id.to_le_bytes();
                    std::ptr::copy_nonoverlapping(id_bytes.as_ptr(), out.add(1), 4);
                }
                needed
            }
            Err(_) => 0,
        }
    }))
    .unwrap_or(0)
}


