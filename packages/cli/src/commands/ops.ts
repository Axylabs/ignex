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
 * The compose target prompts for the MongoDB username/password and writes them
 * into `.env.docker` (loaded via `env_file`), so secrets never appear in the
 * committed compose file. Pass `--db-user`/`--db-password` (or `--yes`) to run
 * non-interactively.
 */

import { join, relative } from "node:path";
import {
  caddyfileTemplate,
  composeTemplate,
  dockerEnvTemplate,
  dockerfileTemplate,
  dockerignoreTemplate,
} from "../templates/ops.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";
import { ask, askConfirm, openPrompt } from "../utils/prompt.js";

export const OPS_TARGETS = ["dockerfile", "compose", "caddy", "docker"] as const;
export type OpsTarget = (typeof OPS_TARGETS)[number];

interface OpsOptions {
  root: string;
  binary: string;
  port: number;
  healthPath: string;
  privateRegistry: boolean;
  appImage: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  dbImage: string;
  replica: boolean;
  mongoUriVar: string;
  domain: string;
  upstream: string;
  force: boolean;
}

const isTarget = (value: string): value is OpsTarget =>
  (OPS_TARGETS as readonly string[]).includes(value);

/** Ask a question only when stdin is a TTY (returns `fallback` otherwise). */
async function askIfTty(question: string, fallback: string, skip = false): Promise<string> {
  if (skip || !process.stdin.isTTY) return fallback;
  const rl = openPrompt();
  try {
    return await ask(rl, question, fallback);
  } finally {
    rl.close();
  }
}

/** Ask for a required (non-empty) password, only when stdin is a TTY. */
async function askPasswordIfTty(question: string, skip = false): Promise<string> {
  if (skip || !process.stdin.isTTY) return "";
  const rl = openPrompt();
  try {
    let password = await ask(rl, question, "");
    while (password.length === 0) {
      password = await ask(rl, "Password cannot be empty — try again", "");
    }
    return password;
  } finally {
    rl.close();
  }
}

/** Confirm a yes/no question only when stdin is a TTY (returns `fallback`). */
async function confirmIfTty(question: string, fallback: boolean, skip = false): Promise<boolean> {
  if (skip || !process.stdin.isTTY) return fallback;
  const rl = openPrompt();
  try {
    return await askConfirm(rl, question, fallback);
  } finally {
    rl.close();
  }
}

/** Write one generated file, honoring `--force` (error + exit when present). */
async function writeOpsFile(
  root: string,
  filename: string,
  content: string,
  force: boolean,
): Promise<boolean> {
  const filePath = join(root, filename);
  if ((await exists(filePath)) && !force) {
    error(`${relative(process.cwd(), filePath)} already exists. Use --force to overwrite.`);
    process.exitCode = 1;
    return false;
  }
  await writeFileEnsuringDir(filePath, content);
  success(`Created ${relative(process.cwd(), filePath)}`);
  return true;
}

async function generateDockerfile(root: string, opts: OpsOptions): Promise<void> {
  step("Generating Dockerfile");
  if (
    !(await writeOpsFile(
      root,
      "Dockerfile",
      dockerfileTemplate({
        binary: opts.binary,
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
  if (!opts.dbPassword) {
    error(
      "MongoDB root password is required. Pass --db-password (and optionally --db-user), or run interactively.",
    );
    process.exitCode = 1;
    return;
  }
  step("Generating docker-compose.yml");
  if (
    !(await writeOpsFile(
      root,
      "docker-compose.yml",
      composeTemplate({
        appImage: opts.appImage,
        dbUser: opts.dbUser,
        dbPassword: opts.dbPassword,
        dbName: opts.dbName,
        dbImage: opts.dbImage,
        replica: opts.replica,
        port: opts.port,
        healthPath: opts.healthPath,
        mongoUriVar: opts.mongoUriVar,
      }),
      opts.force,
    ))
  ) {
    return;
  }
  await writeOpsFile(
    root,
    ".env.docker",
    dockerEnvTemplate({
      dbUser: opts.dbUser,
      dbPassword: opts.dbPassword,
      dbName: opts.dbName,
      replica: opts.replica,
      mongoUriVar: opts.mongoUriVar,
    }),
    opts.force,
  );
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
  console.log();
}

interface ComposeFields {
  dbUser: string;
  dbPassword: string;
  dbName: string;
  replica: boolean;
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
    const answered = await askIfTty(
      "What to generate? (dockerfile/compose/caddy/docker)",
      "docker",
    );
    if (isTarget(answered)) return answered;
  }
  error("Ops target is required. Use: ignex ops dockerfile | compose | caddy | docker");
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

/** Collect compose DB fields from flags or interactive prompts. */
async function resolveComposeFields(values: Record<string, unknown>): Promise<ComposeFields> {
  const skip = Boolean(values.yes);
  const dbUser =
    (values["db-user"] as string | undefined) ??
    (await askIfTty("MongoDB root username", "app", skip));
  const dbPassword =
    (values["db-password"] as string | undefined) ??
    (await askPasswordIfTty("MongoDB root password", skip));
  const dbName =
    (values["db-name"] as string | undefined) ??
    (await askIfTty("MongoDB database name", "app", skip));
  const replica = values["no-replica"]
    ? false
    : values.replica
      ? true
      : await confirmIfTty("Enable a single-node MongoDB replica set?", true, skip);
  return { dbUser, dbPassword, dbName, replica };
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
    case "docker":
      await generateDockerfile(root, opts);
      await generateCompose(root, opts);
      await generateCaddyfile(root, opts);
      break;
  }
}

export async function runOps(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    target: { type: "string" },
    binary: { type: "string" },
    port: { type: "string" },
    "health-path": { type: "string" },
    "private-registry": { type: "boolean" },
    "app-image": { type: "string" },
    "db-user": { type: "string" },
    "db-password": { type: "string" },
    "db-name": { type: "string" },
    "db-image": { type: "string" },
    replica: { type: "boolean" },
    "no-replica": { type: "boolean" },
    "mongo-uri-var": { type: "string" },
    domain: { type: "string" },
    upstream: { type: "string" },
    force: { type: "boolean" },
    yes: { type: "boolean" },
  });

  // First positional is the ops target, never the project root.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const target = await resolveTarget(values, positionals);
  if (!target) return;

  const port = resolvePort(values);
  if (port === undefined) return;

  const wantsDb = target === "compose" || target === "docker";
  const wantsDomain = target === "caddy" || target === "docker";

  const db = wantsDb
    ? await resolveComposeFields(values)
    : { dbUser: "app", dbPassword: "", dbName: "app", replica: false };
  const domain = wantsDomain
    ? ((values.domain as string | undefined) ??
      (await askIfTty("Domain (e.g. example.com)", "example.com", Boolean(values.yes))))
    : "example.com";

  const opts: OpsOptions = {
    root,
    binary: (values.binary as string | undefined) ?? "server",
    port,
    healthPath: (values["health-path"] as string | undefined) ?? "/health",
    privateRegistry: Boolean(values["private-registry"]),
    appImage: (values["app-image"] as string | undefined) ?? "ignex-app:latest",
    dbUser: db.dbUser,
    dbPassword: db.dbPassword,
    dbName: db.dbName,
    dbImage: (values["db-image"] as string | undefined) ?? "percona/percona-server-mongodb:7.0",
    replica: db.replica,
    mongoUriVar: (values["mongo-uri-var"] as string | undefined) ?? "MONGODB_URI",
    domain,
    upstream: (values.upstream as string | undefined) ?? "127.0.0.1:3000",
    force: Boolean(values.force),
  };

  await runTarget(target, root, opts);
  printNextSteps(target);
}
