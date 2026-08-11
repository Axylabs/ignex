# Shared Types

Home of the unified type system shared between the compiler and the runtime.

## Done

- ✅ `ContextUsage` (the compiler ↔ runtime AOT contract) lives here.
- ✅ Functional core (`fp.ts`): `Result`/`Task`/`pipe`/`compose` — imported by
  `@ignus/core`, `@ignus/compiler` and `@ignus/native`.

## Next step

- move HTTP primitives here
- move CompilerOptions here
- make compiler and runtime import from this shared package

This removes duplicated type definitions between:

- src/compiler/types.ts
- src/runtime/types.ts or src/core/types.ts
