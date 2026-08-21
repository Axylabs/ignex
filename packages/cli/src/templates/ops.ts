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

/** Infra services the compose wizard can include, in render order. */
export const COMPOSE_SERVICES = ["mongo", "redis", "nats"] as const;
export type ComposeService = (typeof COMPOSE_SERVICES)[number];

/** Compose service names — the `mongo` option maps to the `mongodb` service. */
export const COMPOSE_SERVICE_NAMES: Record<ComposeService, string> = {
  mongo: "mongodb",
  redis: "redis",
  nats: "nats",
};

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
  /**
   * Infra services to include (default `["mongo"]`). `redis` wires
   * `REDIS_URL` for the framework's cache/session stores, `nats` wires
   * `NATS_URL` (JetStream enabled) for event streaming.
   */
  services?: readonly ComposeService[];
  /** Redis requirepass (default: auto-generated, lives in .env.docker). */
  redisPassword?: string;
  /** Redis image (default "redis:7-alpine"). */
  redisImage?: string;
  /** Env var for the app→redis URL (default "REDIS_URL"). */
  redisUriVar?: string;
  /** NATS image (default "nats:2-alpine"). */
  natsImage?: string;
  /** Env var for the app→nats URL (default "NATS_URL"). */
  natsUriVar?: string;
}

/** Resolve which infra services a compose file includes (default: mongo). */
export const resolveComposeServices = (
  services: readonly ComposeService[] | undefined,
): readonly ComposeService[] => (services && services.length > 0 ? services : (["mongo"] as const));

/** True when the compose file includes a given service. */
export const hasComposeService = (
  services: readonly ComposeService[],
  service: ComposeService,
): boolean => services.includes(service);

/** The MongoDB service block (replica-aware), shared by composeTemplate. */
export function mongoServiceBlock(options: ComposeOptions = {}): string {
  const dbImage = options.dbImage ?? "percona/percona-server-mongodb:latest";
  const replica = Boolean(options.replica);
  const replicaSet = options.replicaSet ?? "rs0";

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

  return `  mongodb:
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
${initService}`;
}

/**
 * Redis service block — `REDIS_PASSWORD` requirepass (from .env.docker) and a
 * `redis-cli ping` healthcheck. Redis backs the framework's cache/session
 * stores via `REDIS_URL`.
 */
export function redisServiceBlock(options: ComposeOptions = {}): string {
  const redisImage = options.redisImage ?? "redis:7-alpine";
  return `  redis:
    image: ${redisImage}
    restart: unless-stopped
    # requirepass reads REDIS_PASSWORD from .env.docker (\`$$\` escapes compose).
    command: ["sh", "-c", 'exec redis-server --requirepass "$$REDIS_PASSWORD" --appendonly yes']
    env_file:
      - .env.docker
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD-SHELL", 'redis-cli -a "$$REDIS_PASSWORD" ping | grep -q PONG']
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 5s
    networks:
      - internal`;
}

/**
 * NATS service block — JetStream enabled (`-js`, persistent to nats-data) with
 * the monitoring port for `/healthz`. NATS powers event streaming / pub-sub
 * via `NATS_URL`.
 */
export function natsServiceBlock(options: ComposeOptions = {}): string {
  const natsImage = options.natsImage ?? "nats:2-alpine";
  return `  nats:
    image: ${natsImage}
    restart: unless-stopped
    # JetStream for durable streams; 8222 exposes the monitoring /healthz.
    command: ["-js", "-m", "8222", "-sd", "/data"]
    ports:
      - "4222:4222"
      - "8222:8222"
    volumes:
      - nats-data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8222/healthz >/dev/null 2>&1 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 5s
    networks:
      - internal`;
}

/** docker-compose.yml — ignex backend + the selected infra services. */
export function composeTemplate(options: ComposeOptions = {}): string {
  const appImage = options.appImage ?? "ignex-app:latest";
  const port = options.port ?? 3000;
  const healthPath = options.healthPath ?? "/health";
  const mongoUriVar = options.mongoUriVar ?? "MONGO_URL";
  const redisUriVar = options.redisUriVar ?? "REDIS_URL";
  const natsUriVar = options.natsUriVar ?? "NATS_URL";
  const services = resolveComposeServices(options.services);

  const replNote =
    hasComposeService(services, "mongo") && options.replica
      ? `#   - MongoDB runs a single-node replica set (${options.replicaSet ?? "rs0"}); the
#     one-shot \`mongodb-init\` service calls rs.initiate() once. A keyFile is
#     generated in the mongo-data volume so --auth (auto-injected from the root
#     user env) works together with --replSet.`
      : "";

  // App-level depends_on (every selected infra service must be healthy).
  const depends = services
    .map(
      (service) => `      ${COMPOSE_SERVICE_NAMES[service]}:\n        condition: service_healthy`,
    )
    .join("\n");

  const blocks: string[] = [];
  if (hasComposeService(services, "mongo")) blocks.push(mongoServiceBlock(options));
  if (hasComposeService(services, "redis")) blocks.push(redisServiceBlock(options));
  if (hasComposeService(services, "nats")) blocks.push(natsServiceBlock(options));

  const volumes = [
    hasComposeService(services, "mongo") ? "  mongo-data:" : "",
    hasComposeService(services, "redis") ? "  redis-data:" : "",
    hasComposeService(services, "nats") ? "  nats-data:" : "",
  ].filter(Boolean);

  const serviceNotes = [
    hasComposeService(services, "mongo")
      ? `#   - MongoDB (\`${mongoUriVar}\` from .env.docker) — the ninox toolkit data store.`
      : "",
    hasComposeService(services, "redis")
      ? `#   - Redis (\`${redisUriVar}\` from .env.docker) — cache / session stores.`
      : "",
    hasComposeService(services, "nats")
      ? `#   - NATS (\`${natsUriVar}\` from .env.docker, JetStream) — event streaming.`
      : "",
  ].filter(Boolean);

  return `# Generated by \`ignex ops compose\`. Secrets live in .env.docker (loaded via
# env_file) — keep .env.docker out of version control.
#
# Usage:
#   docker compose up -d --build
#
# Notes:
#   - TLS is terminated by your proxy (Caddy/nginx); the app runs plain HTTP on
#     port ${port} (IGNEX_HTTPS=0).
${serviceNotes.join("\n")}
${replNote}
#   - Services: ${services.join(", ")}

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
${depends}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:${port}${healthPath}"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 5
    networks:
      - internal

${blocks.join("\n\n")}

volumes:
${volumes.join("\n")}

networks:
  internal:
    driver: bridge
`;
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
# Pinned Bun builder base — no floating \`canary\` in production deploys.
# \`ignex build --compile\` (AOT route compile + bytecode) occasionally needs a
# newer Bun than the latest stable tag; if the build reports an AOT/bytecode
# contract error, bump this ARG deliberately (e.g.
# \`--build-arg BUN_IMAGE=oven/bun:canary-slim\`).
ARG BUN_IMAGE=oven/bun:1.4.0-slim
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

export interface CiWorkflowOptions {
  /**
   * Container registry image. Defaults to `ghcr.io/<owner>/<repo>` (the
   * `github.repository` expression). Only used by the deploy job (main only).
   */
  image?: string;
  /** Deploy host (`user@host`) reached over SSH — omit for build/push only. */
  deployHost?: string;
  /** Remote directory holding `docker-compose.yml` (default `/opt/ignex-app`). */
  deployDir?: string;
}

/**
 * GitHub Actions workflow — CI gate + (optional) image build/push/deploy.
 *
 * The `quality` job mirrors the framework's own gate: install → typecheck →
 * lint → test → AOT build. The scaffolded `test` boots the compiled server, so
 * the test step doubles as the smoke check. The `deploy` job runs only on
 * `main`, builds + pushes a Docker image, and (when a deploy host is given)
 * sshs in to `docker compose pull && up -d` using the files from
 * `ignex ops docker`. Requires a `DEPLOY_SSH_KEY` repo secret when deploying.
 */
export function ciWorkflowTemplate(options: CiWorkflowOptions = {}): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  const image = options.image ?? "ghcr.io/${{ github.repository }}";
  const deployHost = options.deployHost ?? "";
  const deployDir = options.deployDir ?? "/opt/ignex-app";

  const [userRaw, hostRaw] = deployHost.includes("@")
    ? deployHost.split("@")
    : [undefined, deployHost];
  const user = userRaw ?? "root";
  const host = hostRaw ?? "";

  const deploySteps =
    host.length > 0
      ? `
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${host}
          username: ${user || "root"}
          key: \${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd ${deployDir}
            docker compose pull
            docker compose up -d --remove-orphans
            docker image prune -f
`
      : "";

  return `# Generated by \`ignex ops ci\` — CI/CD for an ignex backend.
# Requires repo secrets when deploying: DEPLOY_SSH_KEY.
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    name: Quality gates
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Cache Bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-\${{ runner.os }}-\${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-\${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun run typecheck

      - name: Lint (biome)
        run: bun run lint

      - name: Build (AOT compile)
        run: bun run build

      - name: Test (boots the compiled server)
        run: bun run test

  deploy:
    name: Build image + deploy
    if: github.ref == 'refs/heads/main'
    needs: quality
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build (AOT compile)
        run: bun run build

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${image}
          cache-from: type=gha
          cache-to: type=gha,mode=max
${deploySteps}
`;
}
