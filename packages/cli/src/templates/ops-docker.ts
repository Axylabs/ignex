/**
 * @fileoverview `ignex ops` Dockerfile / `.dockerignore` / `.env.docker`
 * templates. Pure functions (options in, string out), split out of `./ops.ts`
 * (which re-exports them) so each artifact stays reviewable.
 */

import { type ComposeOptions, hasComposeService, resolveComposeServices } from "./ops-compose.js";

export interface DockerfileOptions {
  /** Standalone binary name produced by the build (default "server"). */
  binary?: string;
  /**
   * Compiler output directory containing the compiled binary. Defaults to
   * `.ignex` — the `ignex build` CLI contract. Pass `dist` if the project's
   * build emits into `dist/` (e.g. the monorepo example app's `builder.ts`).
   */
  outDir?: string;
  /** App listen port (default 3000). */
  port?: number;
  /** Health check path (default "/health"). */
  healthPath?: string;
  /**
   * Copy `.npmrc` + `.env` into the builder for private-registry installs.
   * Off by default so builds never break on missing files; `.dockerignore`
   * keeps `.env`/`.npmrc` out of the build context unless this is enabled.
   */
  privateRegistry?: boolean;
}

export interface DockerignoreOptions {
  /** Mirror `DockerfileOptions.privateRegistry` so `.env`/`.npmrc` stay usable. */
  privateRegistry?: boolean;
}

/** Multi-stage Dockerfile: builder (Bun) → slim production image (no Bun). */
export function dockerfileTemplate(options: DockerfileOptions = {}): string {
  const binary = options.binary ?? "server";
  const outDir = options.outDir ?? ".ignex";
  const port = options.port ?? 3000;
  const healthPath = options.healthPath ?? "/health";
  const privateRegistry = Boolean(options.privateRegistry);

  const registryLines = privateRegistry
    ? `# Private registry credentials (used by bun install below)
COPY .npmrc ./
COPY .env ./`
    : `# Uncomment the next two lines only when installing from a private registry
# (and pass --private-registry so .dockerignore keeps .npmrc/.env in context):
# COPY .npmrc ./
# COPY .env ./`;

  return `# ── Stage 1: Builder ──────────────────────────────────────────────────────────
# Pinned Bun builder base — no floating \`canary\` in production deploys.
# \`ignex build --compile\` (AOT route compile + bytecode) occasionally needs a
# newer Bun than the latest stable tag; if the build reports an AOT/bytecode
# contract error, bump this ARG deliberately (e.g.
# \`--build-arg BUN_IMAGE=oven/bun:canary-slim\`).
ARG BUN_IMAGE=oven/bun:1.4.2-slim
FROM \${BUN_IMAGE} AS builder

WORKDIR /app

${registryLines}

# Install dependencies first (layer cache)
COPY package.json bun.lock* ./
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

# Copy source
COPY . .

# Build a standalone binary (AOT route compile, Bun runtime embedded)
ENV NODE_ENV=production
RUN bun run build --compile --binary-outfile ${binary}

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM debian:stable-slim AS production

WORKDIR /app

RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates wget \\
  && rm -rf /var/lib/apt/lists/* \\
  && groupadd --system app \\
  && useradd --system --gid app --create-home --home-dir /app app

COPY --from=builder --chown=app:app /app/${outDir}/${binary} ./${binary}

EXPOSE ${port}

ENV NODE_ENV=production \\
    IGNEX_HTTPS=0 \\
    PORT=${port}

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \\
  CMD wget -qO- http://127.0.0.1:${port}${healthPath} >/dev/null 2>&1 || exit 1

CMD ["./${binary}"]
`;
}

/** `.env.docker` secrets for `ignex ops compose`. Keep out of version control. */
export function dockerEnvTemplate(options: ComposeOptions = {}): string {
  const dbUser = options.dbUser ?? "app";
  const dbPassword = options.dbPassword ?? "";
  const dbName = options.dbName ?? "app";
  const replica = Boolean(options.replica);
  const replicaSet = options.replicaSet ?? "rs0";
  const mongoUriVar = options.mongoUriVar ?? "MONGO_URL";
  const redisUriVar = options.redisUriVar ?? "REDIS_URL";
  const redisPassword = options.redisPassword ?? "";
  const natsUriVar = options.natsUriVar ?? "NATS_URL";
  const services = resolveComposeServices(options.services);

  // The app (ninox) reads MONGO_URL; the root user is created in `admin`, so
  // authSource=admin is required. `mongodb` resolves inside the compose network.
  const uri = `mongodb://${dbUser}:${dbPassword}@mongodb:27017/${dbName}${
    replica ? `?replicaSet=${replicaSet}&authSource=admin` : "?authSource=admin"
  }`;

  const mongoBlock = hasComposeService(services, "mongo")
    ? `MONGO_INITDB_ROOT_USERNAME=${dbUser}
MONGO_INITDB_ROOT_PASSWORD=${dbPassword}
MONGO_INITDB_DATABASE=${dbName}
${mongoUriVar}=${uri}
`
    : "";

  const redisBlock = hasComposeService(services, "redis")
    ? `# Redis — cache / session stores (requirepass).
REDIS_PASSWORD=${redisPassword}
${redisUriVar}=redis://:${redisPassword}@redis:6379
`
    : "";

  const natsBlock = hasComposeService(services, "nats")
    ? `# NATS — event streaming / pub-sub (JetStream enabled in compose).
${natsUriVar}=nats://nats:4222
`
    : "";

  return `# Generated by \`ignex ops compose\` — secrets for docker compose.
# Keep this file out of version control.
${mongoBlock}${redisBlock}${natsBlock}
# Optional app secrets — uncomment and set before deploying:
# SESSION_SECRET=
# JWT_SECRET=
`;
}

/** `.dockerignore` — keeps build context lean and secrets out of the image. */
export function dockerignoreTemplate(options: DockerignoreOptions = {}): string {
  const privateRegistry = Boolean(options.privateRegistry);
  const secretLines = privateRegistry
    ? `# Private-registry mode: .env/.npmrc are intentionally copied into the build
# context for \`bun install\` (see Dockerfile). Remove them after install if they
# must not reach the image layers.`
    : `.env
.npmrc`;

  return `node_modules
dist
.ignex
.git
.gitignore
${secretLines}
.env.docker
uploads
coverage
*.tgz
*.log
Dockerfile
docker-compose.yml
Caddyfile
`;
}
