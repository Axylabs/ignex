import { pathToFileURL } from "node:url";
import { runBuild } from "./commands/build.js";
import { runDev } from "./commands/dev.js";
import { runCreate } from "./commands/create.js";
import { runRoute } from "./commands/route.js";
import { runInfo } from "./commands/info.js";

const HELP = `
@flux/cli

Usage:
  flux create <app-name> [options]
  flux dev [root] [options]
  flux build [root] [options]
  flux route <path> [options]
  flux info [root]

Create options:
  --runtime <bun|node>          Runtime to target
  --pm <bun|npm|pnpm|yarn>      Package manager
  --features <list>             Comma-separated features
  --install                     Install dependencies after scaffolding
  --no-install                  Skip install
  --git                         Initialize git
  --no-git                      Skip git init
  --yes                         Use defaults without prompting
  --force                       Overwrite non-empty target directory

Dev options:
  --root <dir>                  Project root
  --port <port>                 PORT env for spawned server
  --runtime <bun|node|auto>     Runtime used to execute generated server
  --no-spawn                    Build/watch only, do not run server
  --outDir <dir>                Compiler output directory
  --routesDir <dir>             Route directory
  --verbose                     Verbose compiler logs

Build options:
  --root <dir>                  Project root
  --outDir <dir>                Compiler output directory
  --routesDir <dir>             Route directory
  --minify                      Enable minification if supported
  --sourcemap                   Enable sourcemaps if supported
  --verbose                     Verbose compiler logs
  --watch                       Alias for flux dev

Route options:
  --root <dir>                  Project root
  --dir <dir>                   Override routes directory
  --method <method>             get, post, put, patch, del, all
  --schema                      Generate TypeBox schema boilerplate
  --force                       Overwrite existing route file

Examples:
  flux create my-app --runtime bun --features openapi,files,tests --pm bun
  flux dev packages/app
  flux build packages/app --minify
  flux route products/[id].get --schema
  flux route upload.post --method post
`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP.trim());
    return;
  }

  switch (command) {
    case "build": {
      await runBuild(rest);
      return;
    }

    case "dev":
    case "watch": {
      await runDev(rest);
      return;
    }

    case "create":
    case "init":
    case "new":
    case "scaffold": {
      await runCreate(rest);
      return;
    }

    case "route":
    case "r": {
      await runRoute(rest);
      return;
    }

    case "info": {
      await runInfo(rest);
      return;
    }

    default: {
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP.trim());
      process.exitCode = 1;
    }
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}