/**
 * @fileoverview Command registry — the single place CLI commands are declared.
 *
 * Each command carries its name, aliases, description, the flag docs shown in
 * `ignex help`, and its `run` function. `main` in `src/index.ts` dispatches by
 * looking up this registry (no hard-coded switch), so adding a command is a
 * one-line addition here. Commands are grouped in help output for navigation.
 */

import { bold, cyan, dim } from "../utils/logger.js";
import { cliVersion } from "../version.js";
import { runBuild } from "./build.js";
import { runComplete } from "./complete.js";
import { runCompletions } from "./completions.js";
import { runCreate } from "./create.js";
import { runDev } from "./dev.js";
import { runDoctor } from "./doctor.js";
import { runEvent } from "./event.js";
import { runFactory } from "./factory.js";
import { runHook } from "./hook.js";
import { runHotRoute } from "./hotroute.js";
import { runInfo } from "./info.js";
import { runMcp } from "./mcp.js";
import { runMigrate } from "./migrate.js";
import { runModel } from "./model.js";
import { runOps } from "./ops.js";
import { runQueueWork } from "./queue-work.js";
import { runResource } from "./resource.js";
import { runRoute } from "./route.js";
import { runRouteList } from "./route-list.js";
import { runSchedule } from "./schedule-run.js";
import { runSdk } from "./sdk.js";
import { runSeed } from "./seed.js";
import { runTinker } from "./tinker.js";

/** Help sections — keep the command list navigable. */
export type CommandGroup = "Scaffold" | "Develop" | "Deploy" | "Integrate";

export interface Command {
  name: string;
  aliases?: readonly string[];
  description: string;
  /** Help group this command renders under (default "Scaffold"). */
  group?: CommandGroup;
  /** Flag docs / usage shown under this command in `ignex help`. */
  options?: string;
  /** Skip this command in `ignex help` (internal backends like `_complete`). */
  hidden?: boolean;
  run(args: string[]): Promise<void>;
}

const GROUP_ORDER: readonly CommandGroup[] = ["Scaffold", "Develop", "Deploy", "Integrate"];

export const commands: readonly Command[] = [
  {
    name: "create",
    aliases: ["init", "new", "scaffold"],
    group: "Scaffold",
    description: "Scaffold a new app",
    options: `  --runtime <bun>               Runtime to target (bun is the only runtime; the generated server requires Bun)
  --pm <bun|npm|pnpm|yarn>      Package manager
  --root <dir>                  Parent directory for the new app (default: cwd)
  --features <list>             Comma-separated features (auth, refresh adds token refresh/logout; middleware adds global hooks)
  --install                     Install dependencies after scaffolding
  --no-install                  Skip install
  --git                         Initialize git
  --no-git                      Skip git init
  --yes                         Use defaults without prompting
  --force                       Overwrite non-empty target directory`,
    run: runCreate,
  },
  {
    name: "route",
    aliases: ["r"],
    group: "Scaffold",
    description: "Scaffold a route + its src/modules business logic",
    options: `  <path>                        Route path (e.g. products/[id].get, health.get)
  --root <dir>                  Project root
  --dir <dir>                   Override routes directory
  --method <get|post|put|patch|del|all>
                                HTTP method (inferred from a trailing .post etc.)
  --schema                      Generate TypeBox schema boilerplate
  --named                       Generate a named-export handler
  --module                      Scaffold src/modules/<route>.ts + a thin route (default)
  --no-module                   Single-file route (classic behavior)
  --force                       Overwrite existing route file`,
    run: runRoute,
  },
  {
    name: "event",
    aliases: ["events", "ev"],
    group: "Scaffold",
    description: "Scaffold event flows (SSE streams, webhook receivers, event bus)",
    options: `  <kind>                        sse | webhook | bus
  <name>                        Kebab-case event name (e.g. order-created)
  --kind <sse|webhook|bus>      Same as the positional kind
  --name <name>                 Same as the positional name
  --root <dir>                  Project root
  --force                       Overwrite existing files

  sse      → GET /events/<name> SSE stream + producer module
  webhook  → POST /hooks/<name> receiver (receives event data) + module
  bus      → typed in-process event bus (src/lib/events.ts) + publish route + consumer

  Run with no arguments for the interactive wizard.`,
    run: runEvent,
  },
  {
    name: "hook",
    aliases: ["h"],
    group: "Scaffold",
    description: "Scaffold a named or global hook",
    options: `  --root <dir>                  Project root
  --global                      Scaffold a global lifecycle hook (registered on app.config lifecycle)
  --stage <stage>               Lifecycle stage for --global (default beforeHandle)
  --force                       Overwrite existing hook file`,
    run: runHook,
  },
  {
    name: "model",
    aliases: ["m"],
    group: "Scaffold",
    description: "Scaffold a ninox schema-first model",
    options: `  --root <dir>                  Project root
  --dir <dir>                   Override models directory
  --fields <list>               Comma-separated fields (name:string, age:integer, role:enum(a,b), ...)
  --force                       Overwrite existing model file`,
    run: runModel,
  },
  {
    name: "resource",
    aliases: ["res"],
    group: "Scaffold",
    description: "Scaffold a model + pregenerated CRUD routes (Mongo ninox or Drizzle SQL)",
    options: `  --root <dir>                  Project root
  --dir <dir>                   Override models directory
  --fields <list>               Comma-separated fields
  --db <mongo|sql>              Data layer: mongo (ninox, default) or sql (Drizzle/SQLite)
  --auth                        Pre-wire require-auth on every route
  --rbac                        Pre-wire RBAC permissions (withGuards)
  --force                       Overwrite existing files`,
    run: runResource,
  },
  {
    name: "hotroute",
    aliases: ["hot", "hr"],
    group: "Scaffold",
    description:
      "Scaffold a ninox model + hot-cached CRUD split into thin routes + src/modules logic",
    options: `  --root <dir>                  Project root
  --dir <dir>                   Override models directory
  --fields <list>               Comma-separated fields
  --force                       Overwrite existing files`,
    run: runHotRoute,
  },
  {
    name: "migrate",
    aliases: ["migrations", "mg"],
    group: "Scaffold",
    description: "Run the project's DB migrations — ninox (Mongo) or drizzle-kit (--db sql)",
    options: `  <action>                      up (default) | down [name] | status | create <name>
  --root <dir>                  Project root
  --action <up|down|status|create>
                                Same as the positional action
  --name <name>                 Migration name (with create) / target (with down)
  --db <mongo|sql>              mongo (ninox, default) or sql (drizzle-kit)`,
    run: runMigrate,
  },
  {
    name: "queue:work",
    aliases: ["queue", "work"],
    group: "Develop",
    description: "Run durable background jobs as a worker (src/jobs.ts)",
    options: `  --root <dir>                  Project root
  --once                        Process due jobs once, then exit
  --init                        Scaffold src/jobs.ts`,
    run: runQueueWork,
  },
  {
    name: "schedule:run",
    aliases: ["schedule", "scheduler"],
    group: "Develop",
    description: "Run scheduled jobs as a worker (src/schedule.ts)",
    options: `  --root <dir>                  Project root
  --once                        Process due jobs once, then exit`,
    run: runSchedule,
  },
  {
    name: "seed",
    aliases: ["seed-db"],
    group: "Scaffold",
    description: "Run (or scaffold) the DB seed script (src/seed.ts)",
    options: `  --create                      Scaffold src/seed.ts if missing, then run it
  --root <dir>                  Project root`,
    run: runSeed,
  },
  {
    name: "dev",
    aliases: ["watch"],
    group: "Develop",
    description: "Watch + run the app",
    options: `  --root <dir>                  Project root
  --port <port>                 PORT env for spawned server
  --runtime <bun|auto>          Runtime used to execute generated server (bun is the only runtime)
  --no-spawn                    Build/watch only, do not run server
  --kill-port                   Kill the process occupying --port before spawning
  --outDir <dir>                Compiler output directory
  --routesDir <dir>             Route directory
  --minify                      Enable minification if supported
  --sourcemap                   Enable sourcemaps if supported
  --verbose                     Verbose compiler logs`,
    run: runDev,
  },
  {
    name: "build",
    group: "Develop",
    description: "AOT-compile the app",
    options: `  --root <dir>                  Project root
  --outDir <dir>                Compiler output directory
  --routesDir <dir>             Route directory
  --minify                      Enable minification if supported
  --sourcemap                   Enable sourcemaps if supported
  --verbose                     Verbose compiler logs
  --watch                       Alias for ignex dev`,
    run: runBuild,
  },
  {
    name: "doctor",
    aliases: ["check", "diagnose"],
    group: "Develop",
    description: "Check project health (runtime, native, config, build)",
    options: `  --root <dir>                  Project root`,
    run: runDoctor,
  },
  {
    name: "info",
    group: "Develop",
    description: "Show app/compiler info",
    run: runInfo,
  },
  {
    name: "factory",
    aliases: ["make:factory", "f"],
    group: "Scaffold",
    description: "Scaffold a test-data factory for a model",
    options: `  <Name>                        Model name (PascalCase, e.g. User)
  --root <dir>                  Project root
  --dir <dir>                   Override factories directory
  --fields <list>               Comma-separated fields (same DSL as ignex model)
  --force                       Overwrite existing factory`,
    run: runFactory,
  },
  {
    name: "route:list",
    aliases: ["routes", "rl"],
    group: "Develop",
    description: "List app routes (pretty table or --json) from manifest/routes dir",
    options: `  --root <dir>                  Project root
  --json                        Machine-readable JSON output
  --methods <GET,POST>          Filter by method (comma-separated)`,
    run: runRouteList,
  },
  {
    name: "tinker",
    aliases: ["repl", "console"],
    group: "Develop",
    description: "Interactive REPL in the app context (db, env, service, events)",
    options: `  --root <dir>                  Project root
  --no-db                       Skip the Mongo connect at boot`,
    run: runTinker,
  },
  {
    name: "ops",
    aliases: ["devops", "deploy"],
    group: "Deploy",
    description: "Generate deployment files (Dockerfile, docker-compose, Caddyfile, CI workflow)",
    options: `  <target>                      dockerfile | compose | caddy | ci | docker (docker = all)
  --target <dockerfile|compose|caddy|ci|docker>
                                Same as the positional target
  --root <dir>                  Project root
  --port <port>                 App listen port (default 3000)
  --binary <name>               Standalone binary name (default server)
  --out-dir <dir>               Compiler output dir holding the binary (default .ignex)
  --health-path <path>          Health check path (default /health)
  --private-registry            Copy .npmrc/.env into the builder for private installs
  --app-image <image>           App image name for compose (default ignex-app:latest)
  --services <list>             Compose infra services (mongo, redis, nats; default mongo)
  --no-mongo                    Compose without MongoDB (app only or --redis/--nats)
  --redis                       Add Redis to compose (cache / sessions)
  --nats                        Add NATS to compose (event streaming, JetStream)
  --db-user <user>              MongoDB root username (default app)
  --db-password <pass>          MongoDB root password (prompted when omitted)
  --db-name <db>                MongoDB database name (default app)
  --db-image <image>            MongoDB image (default percona/percona-server-mongodb:7.0)
  --replica                     Enable a single-node MongoDB replica set
  --no-replica                  Disable the replica set
  --mongo-uri-var <var>         Env var for the app→db URI (default MONGO_URL)
  --redis-password <pass>       Redis requirepass (generated when omitted)
  --redis-image <image>         Redis image (default redis:7-alpine)
  --redis-uri-var <var>         Env var for the app→redis URI (default REDIS_URL)
  --nats-image <image>          NATS image (default nats:2-alpine)
  --nats-uri-var <var>          Env var for the app→nats URI (default NATS_URL)
  --domain <domain>             Caddy site domain (default example.com)
  --upstream <host:port>        Caddy backend upstream (default 127.0.0.1:3000)
  --image <image>               Registry image for the CI deploy job (default ghcr.io/<owner>/<repo>)
  --deploy-host <user@host>     SSH host to deploy to (ci/docker only; omitted = build/push only)
  --deploy-dir <dir>            Remote dir holding docker-compose.yml (default /opt/ignex-app)
  --yes                         Skip all prompts (use defaults)
  --force                       Overwrite existing files`,
    run: runOps,
  },
  {
    name: "sdk",
    aliases: ["generate-sdk", "sdk:generate"],
    group: "Deploy",
    description: "Generate + distribute the app SDK (typed client) for frontend teams",
    options: `  --platform <ts|openapi|all>    Platform(s) to generate (default: typescript; comma-separated or "all")
  --name <name>                  npm package name (default: <serviceName>-sdk, e.g. @acme/api-sdk)
  --scope <scope>                npm scope for the default name (e.g. @acme)
  --version <semver>             SDK version (default: nearest package.json version)
  --out <dir>                    SDK output directory (default: <outDir>/sdk)
  --tag-prefix <prefix>          Git tag prefix (default: sdk-v)
  --push                         Git-tag the SDK (sdk-v<version>) and push to origin
  --publish                      npm publish (private registry via --registry / SDK_NPM_REGISTRY)
  --registry <url>               npm registry URL for --publish
  --access <public|restricted>   npm access level (default: public)
  --dist-tag <tag>               npm dist-tag (default: latest)
  --release                      Create a GitHub release with the packed tarball (gh CLI or GITHUB_TOKEN)
  --repo <owner/repo>            GitHub repo for --release (default: origin remote)
  --token <token>                GitHub token for --release (default: GITHUB_TOKEN/GH_TOKEN)
  --no-build                     Skip the pre-build (use existing compiled artifacts)
  --dry-run                      Generate + print the plan; push/publish/release nothing`,
    run: runSdk,
  },
  {
    name: "mcp",
    group: "Integrate",
    description: "Run the Model Context Protocol server (stdio)",
    options: `  Exposes agent tools: build, route, info, doctor, openapi, dev
  Run via an MCP client (e.g. npx @modelcontextprotocol/inspector ignex mcp)`,
    run: runMcp,
  },
  {
    name: "completions",
    aliases: ["completion"],
    group: "Integrate",
    description: "Print a shell completion script (bash, zsh, fish, powershell, cmd)",
    options: `  <shell>   bash | zsh | fish | powershell | cmd

  Pipe or source the output to enable tab-completion:
    bash:        source <(ignex completions bash)
    zsh:         source <(ignex completions zsh)
    fish:        ignex completions fish | source
    powershell:  ignex completions powershell | Out-File -Append $PROFILE
    cmd:         ignex completions cmd > %USERPROFILE%\\clink\\ignex.lua  (requires clink)`,
    run: runCompletions,
  },
  {
    name: "_complete",
    hidden: true,
    description: "Shell-completion backend (called by generated completion scripts)",
    run: runComplete,
  },
];

/** Look a command up by name or alias. */
export const findCommand = (name: string): Command | undefined =>
  commands.find((c) => c.name === name || c.aliases?.includes(name));

const ALIAS_LABEL = (aliases: readonly string[] | undefined): string =>
  aliases && aliases.length > 0 ? dim(` (${aliases.join(", ")})`) : "";

const hasOptions = (c: Command): c is Command & { options: string } => c.options !== undefined;

/** One line of the command list, padded to align descriptions. */
function commandLine(c: Command, width: number): string {
  const left = `${cyan(c.name)}${ALIAS_LABEL(c.aliases)}`.padEnd(width);
  return `  ${left} ${c.description}`;
}

/** Render `ignex help` — grouped command list + per-command flag docs. */
export const renderHelp = (): string => {
  const visible = commands.filter((c) => !c.hidden);
  const grouped = new Map<CommandGroup, Command[]>();
  for (const c of visible) {
    const group = c.group ?? "Scaffold";
    grouped.set(group, [...(grouped.get(group) ?? []), c]);
  }

  const width = Math.min(
    42,
    Math.max(...visible.map((c) => c.name.length + (c.aliases?.join(", ").length ?? 0) + 4)),
  );

  const sections = GROUP_ORDER.map((group) => {
    const list = grouped.get(group);
    if (!list || list.length === 0) return "";
    const header = `${bold(group)}`;
    const body = list.map((c) => commandLine(c, width)).join("\n");
    return `${header}\n${body}`;
  }).filter(Boolean);

  const options = visible
    .filter(hasOptions)
    .map(
      (c) =>
        `${bold(`${c.name.charAt(0).toUpperCase()}${c.name.slice(1)} options:`)}\n${c.options}`,
    )
    .join("\n\n");

  return `
${cyan("ignex")} — the Ignex developer CLI ${dim(`(v${cliVersion()})`)}

Usage:
  ignex <command> [options]
  ignex <command> --help       Command-specific help

Commands:
${sections.join("\n\n")}

${options}

Examples:
  ignex create my-app --features auth,openapi --pm bun
  ignex route products/[id].get
  ignex event webhook orders
  ignex ops compose
  ignex dev --kill-port
`;
};

/** Render help for a single command (`ignex <command> --help`). */
export const renderCommandHelp = (command: Command): string => {
  const usage = `ignex ${command.name}${command.options ? " [options]" : ""}`;
  const aliases =
    command.aliases && command.aliases.length > 0
      ? ` (aliases: ${command.aliases.join(", ")})`
      : "";
  const options = command.options ? `${command.options}\n` : "";

  return `
${cyan("ignex")} ${command.name}${dim(aliases)} ${dim(`(v${cliVersion()})`)}

${command.description}

Usage:
  ${usage}

Options:
${options}
`;
};
