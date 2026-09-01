/**
 * @fileoverview Command metadata — the single place ignex commands are declared.
 *
 * This table is pure data (no command implementations are imported) so the
 * root help, the unknown-command guard, and shell completions can all render
 * instantly without paying for compiler/core imports. Each entry pairs with a
 * citty command definition in `commands/<name>.ts`, whose `meta` is filled
 * from {@link metaFor} and whose typed `args` drive per-command usage output.
 *
 * Adding a command = one row here + one loader in `commands/loaders.ts`.
 */

import { bold, cyan, dim } from "../utils/logger.js";
import { cliVersion } from "../version.js";

/** Help sections — keep the command list navigable. */
export type CommandGroup = "Scaffold" | "Develop" | "Ship" | "Integrate";

/** Static metadata for one CLI command. */
export interface CommandRow {
  name: string;
  aliases?: readonly string[];
  description: string;
  /** Help group this command renders under (default "Scaffold"). */
  group?: CommandGroup;
  /** Copy-pasteable examples shown by `ignex help <command>` / `--help`. */
  examples?: readonly string[];
  /** Skip this command in help listings (internal backends like `_complete`). */
  hidden?: boolean;
}

/** Groups in display order. */
export const GROUP_ORDER: readonly CommandGroup[] = ["Scaffold", "Develop", "Ship", "Integrate"];

/** The command table (display order within groups follows declaration order). */
export const commands: readonly CommandRow[] = [
  {
    name: "create",
    aliases: ["init", "new", "scaffold"],
    group: "Scaffold",
    description: "Scaffold a new app",
    examples: [
      "ignex create my-app",
      "ignex create my-app --features auth,openapi --install --git",
      "ignex create api --yes",
    ],
  },
  {
    name: "route",
    aliases: ["r"],
    group: "Scaffold",
    description: "Scaffold a route + its src/modules business logic",
    examples: [
      "ignex route health.get",
      "ignex route products/[id].get --schema",
      "ignex route orders.post --no-module",
    ],
  },
  {
    name: "event",
    aliases: ["events", "ev"],
    group: "Scaffold",
    description: "Scaffold event flows (SSE streams, webhook receivers, event bus)",
    examples: [
      "ignex event sse orders",
      "ignex event webhook github",
      "ignex event bus order-created",
    ],
  },
  {
    name: "hook",
    aliases: ["h"],
    group: "Scaffold",
    description: "Scaffold a named or global hook",
    examples: ["ignex hook require-admin", "ignex hook audit-log --global"],
  },
  {
    name: "model",
    aliases: ["m"],
    group: "Scaffold",
    description: "Scaffold a ninox schema-first model",
    examples: ['ignex model User --fields "name:string,age:integer"'],
  },
  {
    name: "resource",
    aliases: ["res"],
    group: "Scaffold",
    description: "Scaffold a model + pregenerated CRUD routes (Mongo ninox or Drizzle SQL)",
    examples: [
      "ignex resource User",
      'ignex resource Post --db sql --fields "title:string,body:string"',
      "ignex resource Admin --auth --rbac",
    ],
  },
  {
    name: "hotroute",
    aliases: ["hot", "hr"],
    group: "Scaffold",
    description:
      "Scaffold a ninox model + hot-cached CRUD split into thin routes + src/modules logic",
    examples: ['ignex hotroute Product --fields "title:string,price:number"'],
  },
  {
    name: "factory",
    aliases: ["make:factory", "f"],
    group: "Scaffold",
    description: "Scaffold a test-data factory for a model",
    examples: ['ignex factory User --fields "name:string,email:string"'],
  },
  {
    name: "migrate",
    aliases: ["migrations", "mg"],
    group: "Scaffold",
    description: "Run the project's DB migrations — ninox (Mongo) or drizzle-kit (--db sql)",
    examples: [
      "ignex migrate status",
      "ignex migrate create add-slug",
      "ignex migrate down",
      "ignex migrate up --db sql",
    ],
  },
  {
    name: "seed",
    aliases: ["seed-db"],
    group: "Scaffold",
    description: "Run (or scaffold) the DB seed script (src/seed.ts)",
    examples: ["ignex seed", "ignex seed --create"],
  },
  {
    name: "dev",
    aliases: ["watch"],
    group: "Develop",
    description: "Watch + rebuild + run the app (auto-frees the port, crash-restarts)",
    examples: ["ignex dev", "ignex dev --port 4000 --open", "ignex dev --kill-port"],
  },
  {
    name: "build",
    group: "Develop",
    description: "AOT-compile the app into a production-shaped server artifact",
    examples: ["ignex build", "ignex build --minify --sourcemap", "ignex build --watch (= dev)"],
  },
  {
    name: "doctor",
    aliases: ["check", "diagnose"],
    group: "Develop",
    description: "Check project health (runtime, native, config, build)",
    examples: ["ignex doctor"],
  },
  {
    name: "info",
    group: "Develop",
    description: "Print app/compiler info as JSON (runtime, native backend, config)",
    examples: ["ignex info", "ignex info | jq .native"],
  },
  {
    name: "route:list",
    aliases: ["routes", "rl"],
    group: "Develop",
    description: "List app routes (pretty table or JSON) from manifest or routes dir",
    examples: [
      "ignex route:list",
      "ignex routes --json",
      "ignex rl --methods GET,POST",
      "ignex rl --match products",
    ],
  },
  {
    name: "tinker",
    aliases: ["repl", "console"],
    group: "Develop",
    description: "Interactive REPL in the app context (db, env, service, events)",
    examples: ["ignex tinker", "ignex repl --no-db"],
  },
  {
    name: "queue:work",
    aliases: ["queue", "work"],
    group: "Develop",
    description: "Run durable background jobs as a worker (src/jobs.ts)",
    examples: ["ignex queue:work", "ignex queue:work --once", "ignex queue:work --init"],
  },
  {
    name: "schedule:run",
    aliases: ["schedule", "scheduler"],
    group: "Develop",
    description: "Run scheduled jobs as a worker (src/schedule.ts)",
    examples: ["ignex schedule:run", "ignex schedule:run --once"],
  },
  {
    name: "ops",
    aliases: ["devops", "deploy"],
    group: "Ship",
    description: "Generate deployment files (Dockerfile, compose, Caddyfile, CI workflow)",
    examples: [
      "ignex ops dockerfile",
      "ignex ops compose --redis",
      "ignex ops caddy --domain api.acme.com",
      "ignex ops ci --deploy-host me@prod",
    ],
  },
  {
    name: "sdk",
    aliases: ["generate-sdk", "sdk:generate"],
    group: "Ship",
    description: "Generate + distribute the app SDK (typed client) for frontend teams",
    examples: [
      "ignex sdk",
      "ignex sdk --platform openapi --dry-run",
      "ignex sdk --publish --registry https://npm.internal.corp",
    ],
  },
  {
    name: "help",
    group: "Integrate",
    description: "Show help for ignex or a specific command",
    examples: ["ignex help", "ignex help dev", "ignex dev --help"],
  },
  {
    name: "completions",
    aliases: ["completion"],
    group: "Integrate",
    description: "Print a shell completion script (bash, zsh, fish, powershell, cmd)",
    examples: [
      "source <(ignex completions bash)",
      "source <(ignex completions zsh)",
      "ignex completions fish | source",
    ],
  },
  {
    name: "mcp",
    group: "Integrate",
    description: "Run the Model Context Protocol server (stdio) for AI agents",
    examples: ["npx @modelcontextprotocol/inspector ignex mcp"],
  },
  {
    name: "version",
    hidden: true,
    description: "Print the CLI version",
  },
  {
    name: "_complete",
    hidden: true,
    description: "Shell-completion backend (called by generated completion scripts)",
  },
];

/** Look a command row up by name or alias. */
export const findCommand = (name: string): CommandRow | undefined =>
  commands.find((c) => c.name === name || c.aliases?.includes(name));

/** Every public name a user can type to reach a command (names + aliases). */
export const commandNames = (): readonly string[] =>
  commands.filter((c) => !c.hidden).flatMap((c) => [c.name, ...(c.aliases ?? [])]);

/** Extended citty meta carried on every command definition. */
export interface IgnexMeta {
  name: string;
  description: string;
  alias?: string[];
  hidden?: boolean;
  version?: string;
  group?: CommandGroup;
  examples?: readonly string[];
}

/**
 * Build a citty `meta` object for a command from its registry row — one
 * source of truth for names/aliases/descriptions/examples.
 */
export const metaFor = (name: string): IgnexMeta => {
  const row = findCommand(name);
  if (!row) throw new Error(`Unknown command metadata: ${name}`);
  return {
    name: row.name,
    description: row.description,
    ...(row.aliases ? { alias: [...row.aliases] } : {}),
    ...(row.hidden ? { hidden: true } : {}),
    ...(row.group ? { group: row.group } : {}),
    ...(row.examples ? { examples: [...row.examples] } : {}),
  };
};

const ALIAS_LABEL = (aliases: readonly string[] | undefined): string =>
  aliases && aliases.length > 0 ? dim(` (${aliases.join(", ")})`) : "";

/** One line of the command list, padded to align descriptions. */
function commandLine(row: CommandRow, width: number): string {
  const left = `${cyan(row.name)}${ALIAS_LABEL(row.aliases)}`.padEnd(width);
  return `  ${left} ${row.description}`;
}

/** Render the grouped COMMANDS block shared by root help + unknown-command output. */
export const renderGroupedCommands = (): string => {
  const visible = commands.filter((c) => !c.hidden);
  const grouped = new Map<CommandGroup, CommandRow[]>();
  for (const c of visible) {
    const group = c.group ?? "Scaffold";
    grouped.set(group, [...(grouped.get(group) ?? []), c]);
  }

  const width = Math.min(
    40,
    Math.max(...visible.map((c) => c.name.length + (c.aliases?.join(", ").length ?? 0) + 4)),
  );

  return GROUP_ORDER.map((group) => {
    const list = grouped.get(group);
    if (!list || list.length === 0) return "";
    return `${bold(group)}\n${list.map((c) => commandLine(c, width)).join("\n")}`;
  })
    .filter(Boolean)
    .join("\n\n");
};

/** Render the branded root help (`ignex`, `ignex help`, `ignex --help`). */
export const renderRootHelp = (): string => `
${cyan(bold("ignex"))} ${dim(`v${cliVersion()}`)} ${dim("— AOT-first TypeScript framework on Bun")}

${bold("USAGE")}
  ${cyan("$")} ignex ${dim("<command>")} ${dim("[options]")}
  ${cyan("$")} ignex ${cyan("help")} ${dim("<command>")}          ${dim("Help for any command")}
  ${cyan("$")} ignex ${dim("<command>")} ${dim("--help")}

${bold("QUICKSTART")}
  ${cyan("$")} ignex create my-app              ${dim("# scaffold an app (feature wizard)")}
  ${cyan("$")} cd my-app && ignex dev --open    ${dim("# watch + run, opens your browser")}
  ${cyan("$")} ignex resource Post              ${dim("# model + CRUD routes wired to the DB")}

${bold("COMMANDS")}
${renderGroupedCommands()}

${bold("TIPS")}
  ${dim("·")} Run commands from anywhere in your project — the app root is detected automatically.
  ${dim("·")} ${cyan("ignex doctor")} checks runtime/native/config health when something feels off.
  ${dim("·")} Tab-completion: ${cyan("ignex completions bash | source")} (zsh/fish/powershell/cmd too).
`;
