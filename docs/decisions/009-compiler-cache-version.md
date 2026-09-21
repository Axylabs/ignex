# D-009 · COMPILER_CACHE_VERSION bump contract

- Status: accepted
- Context: The AOT cache can serve stale artifacts if codegen/linker output
  shape changes without a version bump.
- Decision: Any codegen/linker output change requires a
  `COMPILER_CACHE_VERSION` bump; `check:cache-versions` gates version-file
  drift.
- Consequences: Cache-invalidation discipline is enforced mechanically.
- Verification: `packages/compiler/src/cache.ts`, `scripts/check-cache-versions.ts`