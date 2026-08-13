/**
 * @fileoverview `@ignex/test-utils` — shared, dev-only test toolkit.
 *
 * This package is never published (it ships only to the workspace) and is
 * wired through the vitest alias `@ignex/test-utils`. It centralises the
 * arbitraries (data-variety generators) and generic response/fs helpers that
 * were previously duplicated across package test folders.
 */

export * from "./arbs";
export * from "./fs";
export * from "./matchers";

import * as fc from "fast-check";

export { fc };
