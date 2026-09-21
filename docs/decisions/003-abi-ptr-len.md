# D-003 · C-ABI (ptr,len) pairs, never cstring buffers

- Status: accepted
- Context: A `(ptr,len)` buffer bound as `cstring` leaves a register
  uninitialized; the resulting garbage header parse was caught only on the
  cross-platform parity lane.
- Decision: All buffer-passing ABI uses explicit `(ptr,len)` pairs. Do not bind
  a length-prefixed buffer as `cstring`. New symbols pass the parity lane
  before shipping.
- Consequences: Slightly noisier FFI declarations; deterministic
  cross-platform behavior.
- Verification: `packages/native/src/ffi/types.ts`, `scripts/verify-native-ffi.ts`, `packages/native/test/wire-hardening.test.ts`