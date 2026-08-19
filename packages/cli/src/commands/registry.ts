/**
 * @fileoverview Command registry — the single place CLI commands are declared.
 *
 * Each command carries its name, aliases, description, the flag docs shown in
 * `ignex help`, and its `run` function. `main` in `src/index.ts` dispatches by
 * looking up this registry (no hard-coded switch), so adding a command is a
 * one-line addition here.
 */

import { runBuild } from "./build.js";
import { runComplete } from "./complete.js";
import { runCompletions } from "./completions.js";
import { runCreate } from "./create.js";
import { runDev } from "./dev.js";
import { runDoctor } from "./doctor.js";
import { runHook } from "./hook.js";
import { runInfo } from "./info.js";
import { runMcp } from "./mcp.js";
import { runModel } from "./model.js";
import { runOps } from "./ops.js";
import { runResource } from "./resource.js";
import { runRoute } from "./route.js";

export interface Command {
  name: string;
  aliases?: readonly string[];
  description: string;
  /** Flag docs / usage shown under this command in `ignex help`. */
  options?: string;
  /** Skip this command in `ignex help` (internal backends like `_complete`). */
  hidden?: boolean;
  run(args: string[]): Promise<void>;
}

export const commands: readonly Command[] = [
  {
    name: "create",
    aliases: ["init", "new", "scaffold"],
    description: "Scaffold a new app",
    options: `  --runtime <bun|node>          Runtime to target
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
    name: "dev",
    aliases: ["watch"],
    description: "Watch + run the app",
    options: `  --root <dir>                  Project root
  --port <port>                 PORT env for spawned server
  --runtime <bun|node|auto>     Runtime used to execute generated server
  --no-spawn                    Build/watch only, do not run server
  --outDir <dir>                Compiler output directory
  --routesDir <dir>             Route directory
  --minify                      Enable minification if supported
  --sourcemap                   Enable sourcemaps if supported
  --verbose                     Verbose compiler logs`,
    run: runDev,
  },
  {
    name: "build",
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
    name: "route",
    aliases: ["r"],
    description: "Scaffold a route file",
    options: `  --root <dir>                  Project root
  --dir <dir>                   Override routes directory
  --method <method>             get, post, put, patch, del, all
  --schema                      Generate TypeBox schema boilerplate
  --named                       Generate a named-export handler
  --force                       Overwrite existing route file`,
    run: runRoute,
  },
  {
    name: "hook",
    aliases: ["h"],
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
    description: "Scaffold a ninox model + pregenerated CRUD routes",
    options: `  --root <dir>                  Project root
  --dir <dir>                   Override models directory
  --fields <list>               Comma-separated fields
  --auth                        Pre-wire require-auth on every route
  --rbac                        Pre-wire RBAC permissions (withGuards)
  --force                       Overwrite existing files`,
    run: runResource,
  },
  {
    name: "ops",
    aliases: ["devops", "deploy"],
    description: "Generate deployment files (Dockerfile, docker-compose, Caddyfile)",
    options: `  <target>                      dockerfile | compose | caddy | docker (docker = all)
  --target <dockerfile|compose|caddy|docker>
                                Same as the positional target
  --root <dir>                  Project root
  --port <port>                 App listen port (default 3000)
  --binary <name>               Standalone binary name (default server)
  --out-dir <dir>               Compiler output dir holding the binary (default .ignex)
  --health-path <path>          Health check path (default /health)
  --private-registry            Copy .npmrc/.env into the builder for private installs
  --app-image <image>           App image name for compose (default ignex-app:latest)
  --db-user <user>              MongoDB root username (default app)
  --db-password <pass>          MongoDB root password (prompted when omitted)
  --db-name <db>                MongoDB database name (default app)
  --db-image <image>            MongoDB image (default percona/percona-server-mongodb:7.0)
  --replica                     Enable a single-node MongoDB replica set
  --no-replica                  Disable the replica set
  --mongo-uri-var <var>         Env var for the app→db URI (default MONGO_URL)
  --domain <domain>             Caddy site domain (default example.com)
  --upstream <host:port>        Caddy backend upstream (default 127.0.0.1:3000)
  --yes                         Skip all prompts (use defaults)
  --force                       Overwrite existing files`,
    run: runOps,
  },
  {
    name: "info",
    description: "Show app/compiler info",
    run: runInfo,
  },
  {
    name: "doctor",
    aliases: ["check", "diagnose"],
    description: "Check project health (runtime, native, config, build)",
    options: `  --root <dir>                  Project root`,
    run: runDoctor,
  },
  {
    name: "mcp",
    description: "Run the Model Context Protocol server (stdio)",
    options: `  Exposes agent tools: build, route, info, doctor, openapi, dev
  Run via an MCP client (e.g. npx @modelcontextprotocol/inspector ignex mcp)`,
    run: runMcp,
  },
  {
    name: "completions",
    aliases: ["completion"],
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
  aliases && aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";

/** Render the full `ignex help` text from the registry. */
export const renderHelp = (): string => {
  const visible = commands.filter((c) => !c.hidden);
  const usage = visible.map((c) => `  ignex ${c.name} [options]`).join("\n");
  const list = visible
    .map((c) => `  ${c.name}${ALIAS_LABEL(c.aliases)}   ${c.description}`)
    .join("\n");
  const hasOptions = (c: Command): c is Command & { options: string } => c.options !== undefined;
  const options = visible
    .filter(hasOptions)
    .map((c) => `${c.name.charAt(0).toUpperCase() + c.name.slice(1)} options:\n${c.options}`)
    .join("\n\n");

  return `
@ignex/cli

Usage:
${usage}

Commands:
${list}

${options}

Examples:
  ignex create my-app --runtime bun --features openapi,files,tests --pm bun
  ignex dev packages/app
  ignex build packages/app --minify
  ignex route products/[id].get --schema
  ignex route upload.post --method post
`;
};
