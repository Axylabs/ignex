# D-004 · Rust owns wire layouts; JS projects them

- Status: accepted
- Context: Ingress/route/scalar wire formats are defined by the Rust addon.
- Decision: Rust owns the layouts; JS projects them from the `castrum_*_layout`
  blobs. `DEFAULT_LAYOUT` parity safety nets are pinned by the FFI verification
  lane.
- Consequences: Layout drift between addon and JS is caught by the parity
  checks instead of surfacing in production.
- Verification: `scripts/verify-native-ffi.ts`, `packages/native/src/route-wire/`