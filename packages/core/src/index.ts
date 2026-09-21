/**
 * @fileoverview Ignex Core — public entry.
 *
 * This barrel is the single public surface of `@ignex/core`. Internally the
 * implementation is grouped by use case into domain folders so each concern
 * stays small and discoverable:
 *
 *   security/   — auth, csrf, crypto, session        (request security & trust)
 *   http/       — context, body, proxy, files, sse, ws, route DSL
 *   data/       — cache, dataloader, lru, query, schema, validation
 *   lifecycle/  — hooks, lifecycle, plugin
 *   platform/   — env, config, jobs, errors
 *   content/    — i18n, template
 *   plugins/    — ready-made IgnexPlugin factories
 *
 * Consumers import everything from `@ignex/core` (or `@ignex/core/http` for the
 * route DSL) — the folder layout is an internal implementation detail.
 *
 * @remarks `/// <reference lib="dom" />` — the framework targets the web
 * platform request model (Request/Response/BodyInit/HeadersInit) implemented
 * by Bun; pulling in the DOM lib from the package entry keeps every consumer's
 * `tsc` compiling against the types this source actually uses, without the
 * consumer having to add `"lib": ["DOM"]` to their own tsconfig.
 *
 * The export surface is partitioned by domain into the sub-barrels under
 * `src/publ/*` (each owning the domain sections that used to live here); the
 * `export *` chain below is the complete, unchanged public surface.
 */
/// <reference lib="dom" />

export * from "./publ/client";
export * from "./publ/content";
export * from "./publ/data";
export * from "./publ/debug";
export * from "./publ/http";
export * from "./publ/lifecycle";
export * from "./publ/native";
export * from "./publ/platform";
export * from "./publ/plugins";
export * from "./publ/realtime";
export * from "./publ/security";
export * from "./publ/shared";
export * from "./publ/types";
