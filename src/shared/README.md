# Shared Types

This directory is reserved for the unified type system.

Next step:

- move HTTP primitives here
- move ContextUsage here
- move CompilerOptions here
- make compiler and runtime import from this shared package

This removes duplicated type definitions between:

- src/compiler/types.ts
- src/runtime/types.ts or src/core/types.ts
