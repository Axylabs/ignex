/**
 * @fileoverview Command registry — the single place CLI commands are declared.
 *
 * Each command carries its name, aliases, description, the flag docs shown in
 * `ignex help`, and its `run` function. `main` in `src/index.ts` dispatches by
 * looking up this registry (no hard-coded switch), so adding a command is a
 * one-line addition here.
 */

import { runBuild } from "./build.js";
import { runCreate } from "./create.js";
import { runDev } from "./dev.js";
import { runInfo } from "./info.js";
import { runMcp } from "./mcp.js";
import { runRoute } from "./route.js";

export interface Command {
  name: string;
  aliases?: readonly string[];
  description: string;
  /** Flag docs / usage shown under this command in `ignex help`. */
  options?: string;
  run(args: string[]): Promise<void>;
}

export const commands: readonly Command[] = [
  {
    name: "create",
    aliases: ["init", "new", "scaffold"],
    description: "Scaffold a new app",
    options: `  --runtime <bun|node>          Runtime to target
  --pm <bun|npm|pnpm|yarn>      Package manager
  --features <list>             Comma-separated features
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
    name: "info",
    description: "Show app/compiler info",
    run: runInfo,
  },
  {
    name: "mcp",
    description: "Run the Model Context Protocol server (stdio)",
    options: `  Exposes agent tools: build, route, info, doctor, openapi, dev
  Run via an MCP client (e.g. npx @modelcontextprotocol/inspector ignex mcp)`,
    run: runMcp,
  },
];

/** Look a command up by name or alias. */
export const findCommand = (name: string): Command | undefined =>
  commands.find((c) => c.name === name || c.aliases?.includes(name));

const ALIAS_LABEL = (aliases: readonly string[] | undefined): string =>
  aliases && aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";

/** Render the full `ignex help` text from the registry. */
export const renderHelp = (): string => {
  const usage = commands.map((c) => `  ignex ${c.name} [options]`).join("\n");
  const list = commands
    .map((c) => `  ${c.name}${ALIAS_LABEL(c.aliases)}   ${c.description}`)
    .join("\n");
  const hasOptions = (c: Command): c is Command & { options: string } => c.options !== undefined;
  const options = commands
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
