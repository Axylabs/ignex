/**
 * @fileoverview `ignex ops compose` templates — `docker-compose.yml` plus the
 * MongoDB / Redis / NATS service blocks and their option types.
 *
 * Pure functions (options in, string out) and pure helpers, split out of
 * `./ops.ts` (which re-exports them) so each artifact stays reviewable.
 */

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
