/**
 * @fileoverview Public sub-barrel: the typed HTTP client surface re-exported
 * from the `@ignex/core` entry (split from the barrel `src/index.ts` by section
 * banner — move-only; `export` statements verbatim).
 */

// ── client / openapi (consumer-facing) ──────────────────────────
export type { ClientOptions, ClientResponse, IgnexClient } from "../client";
export { createClient } from "../client";
