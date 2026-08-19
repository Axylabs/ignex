/**
 * @fileoverview `ignex ops` deployment templates — pure functions returning
 * Dockerfile / docker-compose / Caddyfile / env / dockerignore contents.
 *
 * Everything here targets the ignex runtime contract:
 *   - `PORT` env (default 3000) and the `GET /health` liveness probe.
 *   - A standalone binary produced by
 *     `ignex build --compile --binary-outfile <name>` (no Bun runtime needed).
 *   - TLS terminated at the proxy (Caddy/nginx), so the container runs plain
 *     HTTP via `IGNEX_HTTPS=0`.
 *
 * These functions are pure (options in, string out) so they can be unit-tested
 * directly, mirroring `routeFileTemplate` in `./route.ts`.
 */

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

export interface ComposeOptions {
  /** App image name (default "ignex-app:latest"). */
  appImage?: string;
  /** MongoDB root username (default "app"). */
  dbUser?: string;
  /** MongoDB root password (required to "set it" — see `ignex ops compose`). */
  dbPassword?: string;
  /** MongoDB database name (default "app"). */
  dbName?: string;
  /** Percona MongoDB image (default "percona/percona-server-mongodb:7.0"). */
  dbImage?: string;
  /** Enable a single-node replica set (default false). */
  replica?: boolean;
  /** Replica set name (default "rs0"). */
  replicaSet?: string;
  /** App listen port (default 3000). */
  port?: number;
  /** Health check path (default "/health"). */
  healthPath?: string;
  /** Env var for the app→db connection string (default "MONGO_URL"). */
  mongoUriVar?: string;
}

export interface CaddyfileOptions {
  /** Site domains (default ["example.com"]). */
  domains?: string[];
  /** Backend upstream host:port (default "127.0.0.1:3000"). */
  upstream?: string;
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
# canary-slim: ignex build --compile (AOT route compile + bytecode) requires a
# recent Bun canary; the stable tag can lag behind the AOT contract.
FROM oven/bun:canary-slim AS builder

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

/** docker-compose.yml — ignex backend + Percona MongoDB (optional replica set). */
export function composeTemplate(options: ComposeOptions = {}): string {
  const appImage = options.appImage ?? "ignex-app:latest";
  const dbImage = options.dbImage ?? "percona/percona-server-mongodb:latest";
  const replica = Boolean(options.replica);
  const replicaSet = options.replicaSet ?? "rs0";
  const port = options.port ?? 3000;
  const healthPath = options.healthPath ?? "/health";
  const mongoUriVar = options.mongoUriVar ?? "MONGO_URL";

  // mongod refuses `--auth` (auto-injected by the entrypoint when
  // MONGO_INITDB_ROOT_USERNAME is set) combined with `--replSet` unless a
  // keyFile is supplied — so the replica-set member wraps the entrypoint to
  // create a persistent keyFile in the mongo-data volume, then hands off to
  // /entrypoint.sh which still does first-run root-user provisioning.
  //
  // NB: entrypoint is a list whose last element is the full script; podman-
  // compose shlex.splits any *string* `command`/`entrypoint`, which would
  // mangle a multi-word `sh -c` script.
  const mongoConfig = replica
    ? `    entrypoint:
      - /bin/sh
      - -c
      - |
        set -e
        KEYFILE=/data/db/keyfile
        if [ ! -s "$$KEYFILE" ]; then
          openssl rand -base64 756 > "$$KEYFILE"
        fi
        chmod 400 "$$KEYFILE"
        exec /entrypoint.sh mongod --bind_ip_all --replSet ${replicaSet} --keyFile "$$KEYFILE"`
    : `    command: ["mongod", "--bind_ip_all"]`;

  const replNote = replica
    ? `#   - MongoDB runs a single-node replica set (${replicaSet}); the
#     one-shot \`mongodb-init\` service calls rs.initiate() once. A keyFile is
#     generated in the mongo-data volume so --auth (auto-injected from the root
#     user env) works together with --replSet.`
    : `#   - MongoDB runs standalone (no replica set); disable with --no-replica.`;

  const initService = replica
    ? `
  # One-shot replica-set init — starts the single-node set once.
  mongodb-init:
    image: ${dbImage}
    restart: "no"
    depends_on:
      mongodb:
        condition: service_healthy
    env_file:
      - .env.docker
    entrypoint:
      - /bin/sh
      - -c
      - |
        mongosh --quiet --host mongodb:27017 \
          --username "$$MONGO_INITDB_ROOT_USERNAME" \
          --password "$$MONGO_INITDB_ROOT_PASSWORD" \
          --authenticationDatabase admin \
          --eval 'try { rs.status().ok } catch { rs.initiate({_id: "${replicaSet}", members: [{_id: 0, host: "mongodb:27017"}]}) }'
    networks:
      - internal
`
    : "";

  return `# Generated by \`ignex ops compose\`. Secrets live in .env.docker (loaded via
# env_file) — keep .env.docker out of version control.
#
# Usage:
#   docker compose up -d --build
#
# Notes:
#   - TLS is terminated by your proxy (Caddy/nginx); the app runs plain HTTP on
#     port ${port} (IGNEX_HTTPS=0).
${replNote}
#   - The app connects via \`${mongoUriVar}\` from .env.docker

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    image: ${appImage}
    restart: unless-stopped
    env_file:
      - .env.docker
    environment:
      NODE_ENV: production
      IGNEX_HTTPS: "0"
      PORT: "${port}"
    ports:
      - "${port}:${port}"
    depends_on:
      mongodb:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:${port}${healthPath}"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 5
    networks:
      - internal

  mongodb:
    image: ${dbImage}
    restart: unless-stopped
${mongoConfig}
    env_file:
      - .env.docker
    # Expose on the host so local dev (and GUI tools) can connect to
    # localhost:27017 with the MONGO_URL from .env.example.
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
    healthcheck:
      # CMD-SHELL form (plain scalar): \`$$\` escapes compose interpolation so
      # the shell sees the MONGO_INITDB_* vars injected via env_file.
      test: mongosh --quiet --host 127.0.0.1 --username "$$MONGO_INITDB_ROOT_USERNAME" --password "$$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand('ping').ok" | grep -q 1
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    networks:
      - internal
${initService}
volumes:
  mongo-data:

networks:
  internal:
    driver: bridge
`;
}

/** Optimized Caddyfile — TLS termination + HSTS in front of the ignex backend. */
export function caddyfileTemplate(options: CaddyfileOptions = {}): string {
  const domains = options.domains && options.domains.length > 0 ? options.domains : ["example.com"];
  const upstream = options.upstream ?? "127.0.0.1:3000";
  const site = domains.join(", ");

  return `# Caddyfile generated by \`ignex ops caddy\` — reverse proxy for an ignex backend.
#
# Optimizations:
#   - Caddy terminates TLS (auto Let's Encrypt) and serves HTTP/2 + HTTP/3.
#   - The app already sends its security headers (CSP, COEP/COOP, ...) via
#     \`server.headers\`; HSTS is deliberately NOT set by the app (it belongs at
#     the TLS terminator), so we add it here.
#   - No \`encode gzip\`: the app compresses via its \`compression()\` plugin, so
#     re-compressing here would waste CPU.
#   - WebSockets / SSE (e.g. the /jobs and /session routes) pass through
#     automatically — Caddy upgrades them by default.

${site} {
	# Host → backend. Change to the service name when the backend runs in the
	# same compose network (e.g. app:3000).
	reverse_proxy ${upstream}

	header {
		# HSTS — only ever sent over HTTPS (Caddy is the TLS terminator).
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
	}
}
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

  // The app (ninox) reads MONGO_URL; the root user is created in `admin`, so
  // authSource=admin is required. `mongodb` resolves inside the compose network.
  const uri = `mongodb://${dbUser}:${dbPassword}@mongodb:27017/${dbName}${
    replica ? `?replicaSet=${replicaSet}&authSource=admin` : "?authSource=admin"
  }`;

  return `# Generated by \`ignex ops compose\` — secrets for docker compose.
# Keep this file out of version control.
MONGO_INITDB_ROOT_USERNAME=${dbUser}
MONGO_INITDB_ROOT_PASSWORD=${dbPassword}
MONGO_INITDB_DATABASE=${dbName}
${mongoUriVar}=${uri}

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
