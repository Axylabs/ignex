/**
 * @fileoverview `ignex ops` deployment templates — pure functions returning
 * Dockerfile / docker-compose / Caddyfile / env / dockerignore / CI contents.
 *
 * Everything here targets the ignex runtime contract:
 *   - `PORT` env (default 3000) and the `GET /health` liveness probe.
 *   - A standalone binary produced by
 *     `ignex build --compile --binary-outfile <name>` (no Bun runtime needed).
 *   - TLS terminated at the proxy (Caddy/nginx), so the container runs plain
 *     HTTP via `IGNEX_HTTPS=0`.
 *
 * These functions are pure (options in, string out) so they can be unit-tested
 * directly, mirroring `routeFileTemplate` in `./route.ts`. The implementations
 * live in the `ops-*.ts` siblings; this module is the single import path.
 */

export * from "./ops-ci.js";
export * from "./ops-compose.js";
export * from "./ops-docker.js";
export * from "./ops-proxy.js";
