/**
 * @fileoverview `phases/artifacts` — AOT artifact generation.
 *
 * Modules: route-types, client, openapi, manifest, write. The folder layout
 * is an internal implementation detail; consumers import `../phases/artifacts`
 * (resolves to this barrel).
 */

export { generateClient, generateClientDts } from "./client";
export { generateManifest } from "./manifest";
export { generateOpenApi } from "./openapi";
export { generateRouteTypes } from "./route-types";
export { writeArtifacts, writeGuarded } from "./write";
