# @ignex/test-utils

Shared test helpers for the ignex workspace packages — property-based
arbitraries and custom matchers used across the core/compiler/native suites.

## What's inside (`src/`)

| Module | What it provides |
| --- | --- |
| `arbs.ts` | `fast-check` arbitraries for ignex data shapes (request-ish objects, schema fragments, byte buffers) |
| `matchers.ts` | Custom vitest matchers (e.g. byte-array equality with helpful diffs) |
| `index.ts` | Barrel re-export of the above |

## Usage

```ts
import { arbBytes, toEqualBytes } from "@ignex/test-utils";
```

Consumed via the root vitest config alias (`@ignex/test-utils` → source) — no
build step, matching the source-only convention of every workspace package.

## Notes

- Deliberately has **no test directory**: it exists to be consumed by other
  packages' suites; its correctness is exercised through them.
- Depends only on `fast-check` (peer of the repo's property-testing workflow).
