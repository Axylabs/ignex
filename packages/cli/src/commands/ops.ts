/**
 * @fileoverview `ignex ops` — generate deployment files for an ignex backend:
 *
 *   ignex ops dockerfile   → Dockerfile + .dockerignore
 *   ignex ops compose      → docker-compose.yml + .env.docker (secrets)
 *   ignex ops caddy        → Caddyfile (optimized reverse proxy)
 *   ignex ops docker       → all of the above (interactive)
 *
 * Generated files target the ignex runtime contract: `PORT` (default 3000),
 * `GET /health`, TLS terminated at the proxy (`IGNEX_HTTPS=0`), and a
 * standalone binary produced by `ignex build --compile --binary-outfile <name>`.
 *
 * The compose target runs an interactive wizard: pick which infra services to
 * include (MongoDB for the ninox toolkit, Redis for cache/sessions, NATS for
 * event streaming) and supply their credentials. Secrets are written to
 * `.env.docker` (loaded via `env_file`), so they never appear in the committed
 * compose file. Pass flags (`--services`, `--db-user`, `--redis-password`,
 * ...) or `--yes` to run non-interactively.
 */

import { join } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import {
  COMPOSE_SERVICES,
  type ComposeService,
  caddyfileTemplate,
  ciWorkflowTemplate,
  composeTemplate,
  dockerEnvTemplate,
  dockerfileTemplate,
  dockerignoreTemplate,
} from "../templates/ops.js";
import { secureRandomBytes } from "../utils/bun-compat.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { error, info, step, warn } from "../utils/logger.js";
import {
  PromptCancelError,
  promptConfirm,
  promptMultiSelect,
  promptPassword,
  promptSelect,
  promptText,
} from "../utils/prompt.js";
import { writeScaffold } from "../utils/scaffold.js";
import { metaFor } from "./registry.js";

export const OPS_TARGETS = ["dockerfile", "compose", "caddy", "ci", "docker"] as const;
export type OpsTarget = (typeof OPS_TARGETS)[number];

/** Default infra services for `ignex ops compose` (kept scriptable). */
export const DEFAULT_COMPOSE_SERVICES: readonly ComposeService[] = ["mongo"];

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  root: { type: "string", valueHint: "dir", description: "Project root" },
  target: {
    type: "string",
    valueHint: "dockerfile|compose|caddy|ci|docker",
    description: "Ops target (also accepted as the first positional)",
  },
  binary: { type: "string", valueHint: "name", description: "Binary name for the Dockerfile" },
  "out-dir": { type: "string", valueHint: "dir", description: "Compiler output directory" },
  port: { type: "string", valueHint: "port", description: "App port (default 3000)" },
  "health-path": { type: "string", valueHint: "path", description: "Health check path" },
  "private-registry": { type: "boolean", description: "Target a private image registry" },
  "app-image": { type: "string", valueHint: "image", description: "App image name" },
  services: {
    type: "string",
    valueHint: "mongo,redis,nats",
    description: "Comma-separated compose services",
  },
  mongo: {
    type: "boolean",
    default: true,
    description: "Include MongoDB in compose (--no-mongo to exclude)",
  },
  redis: { type: "boolean", description: "Include Redis in compose" },
  nats: { type: "boolean", description: "Include NATS in compose" },
  "db-user": { type: "string", description: "MongoDB root username" },
  "db-password": { type: "string", description: "MongoDB root password" },
  "db-name": { type: "string", description: "MongoDB database name" },
  "db-image": { type: "string", valueHint: "image", description: "MongoDB image" },
  replica: {
    type: "boolean",
    description: "Enable a single-node replica set (--no-replica to disable)",
  },
  "mongo-uri-var": { type: "string", valueHint: "VAR", description: "MONGO_URL env var name" },
  "redis-password": { type: "string", description: "Redis password" },
  "redis-image": { type: "string", valueHint: "image", description: "Redis image" },
  "redis-uri-var": { type: "string", valueHint: "VAR", description: "REDIS_URL env var name" },
  "nats-image": { type: "string", valueHint: "image", description: "NATS image" },
  "nats-uri-var": { type: "string", valueHint: "VAR", description: "NATS_URL env var name" },
  domain: { type: "string", valueHint: "domain", description: "Public domain for Caddy" },
  upstream: { type: "string", valueHint: "host:port", description: "Upstream for Caddy" },
  image: { type: "string", valueHint: "image", description: "CI deploy image" },
  "deploy-host": { type: "string", valueHint: "user@host", description: "CI deploy target" },
  "deploy-dir": { type: "string", valueHint: "dir", description: "CI deploy directory" },
  force: { type: "boolean", description: "Overwrite existing files" },
  yes: { type: "boolean", description: "Skip interactive prompts (use defaults)" },
} satisfies ArgsDef;

export const opsCmd = defineCommand({
  meta: metaFor("ops"),
  args: argsDef,
  async run(ctx) {
    await runOps(ctx.rawArgs);
  },
});

export default opsCmd;

interface OpsOptions {
  root: string;
  binary: string;
  outDir: string;
  port: number;
  healthPath: string;
  privateRegistry: boolean;
  appImage: string;
  services: readonly ComposeService[];
  dbUser: string;
  dbPassword: string;
  dbName: string;
  dbImage: string;
  replica: boolean;
  mongoUriVar: string;
  redisPassword: string;
  redisImage: string;
  redisUriVar: string;
  natsImage: string;
  natsUriVar: string;
  domain: string;
  upstream: string;
  image: string;
  deployHost: string;
  deployDir: string;
  force: boolean;
}

const isTarget = (value: string): value is OpsTarget =>
  (OPS_TARGETS as readonly string[]).includes(value);

const isService = (value: string): value is ComposeService =>
  (COMPOSE_SERVICES as readonly string[]).includes(value);

/**
 * Run an interactive prompt, cancelling (Ctrl+C) into a clean `Cancel` result
 * instead of a thrown error. Non-TTY callers get `fallback`.
 */
async function wizard<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  if (!process.stdin.isTTY) return fallback;
  try {
    return await run();
  } catch (err) {
    if (err instanceof PromptCancelError) {
      warn("Cancelled — nothing was written.");
      return fallback;
    }
    throw err;
  }
}

/** Write one generated file, honoring `--force` (error + exit when present). */
async function writeOpsFile(
  root: string,
  filename: string,
  content: string,
  force: boolean,
): Promise<boolean> {
  return writeScaffold(join(root, filename), content, { force, overwrite: true });
}

async function generateDockerfile(root: string, opts: OpsOptions): Promise<void> {
  step("Generating Dockerfile");
  if (
    !(await writeOpsFile(
      root,
      "Dockerfile",
      dockerfileTemplate({
        binary: opts.binary,
        outDir: opts.outDir,
        port: opts.port,
        healthPath: opts.healthPath,
        privateRegistry: opts.privateRegistry,
      }),
      opts.force,
    ))
  ) {
    return;
  }
  await writeOpsFile(
    root,
    ".dockerignore",
    dockerignoreTemplate({ privateRegistry: opts.privateRegistry }),
    opts.force,
  );
}

async function generateCompose(root: string, opts: OpsOptions): Promise<void> {
  const composeOpts = {
    appImage: opts.appImage,
    dbUser: opts.dbUser,
    dbPassword: opts.dbPassword,
    dbName: opts.dbName,
    dbImage: opts.dbImage,
    replica: opts.replica,
    port: opts.port,
    healthPath: opts.healthPath,
    mongoUriVar: opts.mongoUriVar,
    services: opts.services,
    redisPassword: opts.redisPassword,
    redisImage: opts.redisImage,
    redisUriVar: opts.redisUriVar,
    natsImage: opts.natsImage,
    natsUriVar: opts.natsUriVar,
  };
  step(
    `Generating docker-compose.yml (services: ${opts.services.length > 0 ? opts.services.join(", ") : "app only"})`,
  );
  if (!(await writeOpsFile(root, "docker-compose.yml", composeTemplate(composeOpts), opts.force))) {
    return;
  }
  await writeOpsFile(root, ".env.docker", dockerEnvTemplate(composeOpts), opts.force);
  info("Secrets were written to .env.docker — keep it out of version control.");
}

async function generateCaddyfile(root: string, opts: OpsOptions): Promise<void> {
  step("Generating Caddyfile");
  await writeOpsFile(
    root,
    "Caddyfile",
    caddyfileTemplate({ domains: [opts.domain], upstream: opts.upstream }),
    opts.force,
  );
}

async function generateCi(root: string, opts: OpsOptions): Promise<void> {
  step("Generating .github/workflows/ci.yml");
  await writeOpsFile(
    root,
    join(".github", "workflows", "ci.yml"),
    ciWorkflowTemplate({
      image: opts.image,
      deployHost: opts.deployHost,
      deployDir: opts.deployDir,
    }),
    opts.force,
  );
}

function printNextSteps(target: OpsTarget): void {
  console.log();
  console.log("Next steps:");
  if (target === "dockerfile" || target === "docker") {
    console.log("  docker build -t <image> .");
  }
  if (target === "compose" || target === "docker") {
    console.log("  docker compose up -d --build   # reads secrets from .env.docker");
  }
  if (target === "caddy" || target === "docker") {
    console.log("  caddy run                       # uses Caddyfile in this directory");
  }
  if (target === "ci" || target === "docker") {
    console.log("  git push                        # runs typecheck/lint/test/build in CI");
  }
  console.log();
}

interface ComposeFields {
  services: readonly ComposeService[];
  dbUser: string;
  dbPassword: string;
  dbName: string;
  replica: boolean;
  redisPassword: string;
}

/** Resolve the ops target from `--target`, the positional, or an interactive prompt. */
async function resolveTarget(
  values: Record<string, unknown>,
  positionals: readonly string[],
): Promise<OpsTarget | undefined> {
  const raw = (values.target as string | undefined) ?? positionals[0];
  if (raw !== undefined) {
    if (!isTarget(raw)) {
      error(`Unknown ops target "${raw}". Expected one of: ${OPS_TARGETS.join(", ")}.`);
      process.exitCode = 1;
      return undefined;
    }
    return raw;
  }
  if (process.stdin.isTTY && !values.yes) {
    const answered = await wizard(
      () =>
        promptSelect({
          message: "What should I generate?",
          options: [
            {
              value: "docker",
              label: "Docker (all)",
              hint: "Dockerfile + compose + Caddyfile + CI",
            },
            { value: "dockerfile", label: "Dockerfile", hint: "multi-stage build + .dockerignore" },
            {
              value: "compose",
              label: "docker-compose",
              hint: "app + infra services (.env.docker)",
            },
            { value: "caddy", label: "Caddyfile", hint: "TLS reverse proxy" },
            { value: "ci", label: "CI workflow", hint: "GitHub Actions quality gate + deploy" },
          ],
          initial: "docker",
        }),
      "docker",
    );
    if (isTarget(answered)) return answered;
  }
  error("Ops target is required. Use: ignex ops dockerfile | compose | caddy | ci | docker");
  process.exitCode = 1;
  return undefined;
}

/** Validate --port, defaulting to 3000. */
function resolvePort(values: Record<string, unknown>): number | undefined {
  const port = Number(values.port ?? 3000);
  if (!Number.isFinite(port)) {
    error(`Invalid --port "${String(values.port)}".`);
    process.exitCode = 1;
    return undefined;
  }
  return port;
}

/** Resolve the selected infra services from flags or an interactive picker. */
async function resolveServices(
  values: Record<string, unknown>,
): Promise<readonly ComposeService[]> {
  const raw = values.services as string | undefined;
  if (raw !== undefined) {
    const parsed = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = parsed.filter((s) => !isService(s));
    if (unknown.length > 0) {
      error(
        `Unknown service(s): ${unknown.join(", ")}. Expected one of: ${COMPOSE_SERVICES.join(", ")}.`,
      );
      process.exitCode = 1;
      return [];
    }
    return [...new Set(parsed)] as ComposeService[];
  }

  // Individual toggles: --redis / --nats add, --no-mongo removes (citty
  // native boolean negation: `--no-mongo` → `values.mongo === false`).
  const base = new Set(DEFAULT_COMPOSE_SERVICES);
  if (values.mongo === false) base.delete("mongo");
  if (values.redis === true) base.add("redis");
  if (values.nats === true) base.add("nats");

  if (!process.stdin.isTTY || values.yes) return [...base];

  const picked = await wizard(
    () =>
      promptMultiSelect({
        message: "Which infra services should docker compose include?",
        hint: "Space toggles · a selects all · Enter confirms",
        options: [
          { value: "mongo", label: "MongoDB", hint: "ninox data store (MONGO_URL)" },
          { value: "redis", label: "Redis", hint: "cache / sessions (REDIS_URL)" },
          { value: "nats", label: "NATS", hint: "event streaming / pub-sub (NATS_URL, JetStream)" },
        ],
        initial: [...base],
      }),
    [...base],
  );
  return picked as ComposeService[];
}

/**
 * Collect the compose fields (services + per-service credentials) from flags
 * or the interactive wizard.
 */
async function resolveComposeFields(values: Record<string, unknown>): Promise<ComposeFields> {
  const services = await resolveServices(values);
  if (services.length === 0 && process.exitCode !== 0) {
    // resolveServices already errored (unknown service) — stop.
    return {
      services,
      dbUser: "app",
      dbPassword: "",
      dbName: "app",
      replica: false,
      redisPassword: "",
    };
  }
  const wantsMongo = services.includes("mongo");
  const wantsRedis = services.includes("redis");

  const dbUser =
    (values["db-user"] as string | undefined) ??
    (wantsMongo
      ? await wizard(() => promptText({ message: "MongoDB root username", initial: "app" }), "app")
      : "app");
  let dbPassword =
    (values["db-password"] as string | undefined) ??
    (wantsMongo
      ? await wizard(() => promptPassword({ message: "MongoDB root password" }), "")
      : "");
  if (!dbPassword) {
    dbPassword = secureRandomBytes(18).toString("base64url");
    warn(
      "[ignex] no --db-password provided; generated a random MongoDB root password (saved to .env.docker).",
    );
  }
  const dbName =
    (values["db-name"] as string | undefined) ??
    (wantsMongo
      ? await wizard(() => promptText({ message: "MongoDB database name", initial: "app" }), "app")
      : "app");
  const replica = wantsMongo
    ? values.replica === false
      ? false
      : values.replica === true
        ? true
        : await wizard(
            () =>
              promptConfirm({
                message: "Enable a single-node MongoDB replica set?",
                initial: true,
              }),
            true,
          )
    : false;

  let redisPassword =
    (values["redis-password"] as string | undefined) ??
    (wantsRedis ? await wizard(() => promptPassword({ message: "Redis password" }), "") : "");
  if (wantsRedis && !redisPassword) {
    redisPassword = secureRandomBytes(18).toString("base64url");
    warn(
      "[ignex] no --redis-password provided; generated a random Redis password (saved to .env.docker).",
    );
  }

  return { services, dbUser, dbPassword, dbName, replica, redisPassword };
}

/** Dispatch to the generator(s) for the chosen target. */
async function runTarget(target: OpsTarget, root: string, opts: OpsOptions): Promise<void> {
  switch (target) {
    case "dockerfile":
      await generateDockerfile(root, opts);
      break;
    case "compose":
      await generateCompose(root, opts);
      break;
    case "caddy":
      await generateCaddyfile(root, opts);
      break;
    case "ci":
      await generateCi(root, opts);
      break;
    case "docker":
      await generateDockerfile(root, opts);
      await generateCompose(root, opts);
      await generateCaddyfile(root, opts);
      await generateCi(root, opts);
      break;
  }
}

export async function runOps(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  // First positional is the ops target, never the project root.
  const root = await resolveProjectRoot(parsed.root);
  const target = await resolveTarget(parsed, parsed._);
  if (!target) return;

  const port = resolvePort(parsed);
  if (port === undefined) return;

  const wantsCompose = target === "compose" || target === "docker";
  const wantsDomain = target === "caddy" || target === "docker";

  const db = wantsCompose
    ? await resolveComposeFields(parsed)
    : {
        services: [] as readonly ComposeService[],
        dbUser: "app",
        dbPassword: "",
        dbName: "app",
        replica: false,
        redisPassword: "",
      };
  if (wantsCompose && db.services.length === 0 && process.exitCode !== 0) return;

  const domain = wantsDomain
    ? (parsed.domain ??
      (await wizard(
        () => promptText({ message: "Domain (e.g. example.com)", initial: "example.com" }),
        "example.com",
      )))
    : "example.com";

  const opts: OpsOptions = {
    root,
    binary: parsed.binary ?? "server",
    outDir: parsed["out-dir"] ?? ".ignex",
    port,
    healthPath: parsed["health-path"] ?? "/health",
    privateRegistry: Boolean(parsed["private-registry"]),
    appImage: parsed["app-image"] ?? "ignex-app:latest",
    services: db.services,
    dbUser: db.dbUser,
    dbPassword: db.dbPassword,
    dbName: db.dbName,
    dbImage: parsed["db-image"] ?? "percona/percona-server-mongodb:7.0",
    replica: db.replica,
    mongoUriVar: parsed["mongo-uri-var"] ?? "MONGO_URL",
    redisPassword: db.redisPassword,
    redisImage: parsed["redis-image"] ?? "redis:7-alpine",
    redisUriVar: parsed["redis-uri-var"] ?? "REDIS_URL",
    natsImage: parsed["nats-image"] ?? "nats:2-alpine",
    natsUriVar: parsed["nats-uri-var"] ?? "NATS_URL",
    domain,
    upstream: parsed.upstream ?? "127.0.0.1:3000",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    image: parsed.image ?? "ghcr.io/${{ github.repository }}",
    deployHost: parsed["deploy-host"] ?? "",
    deployDir: parsed["deploy-dir"] ?? "/opt/ignex-app",
    force: Boolean(parsed.force),
  };

  await runTarget(target, root, opts);
  printNextSteps(target);
}
