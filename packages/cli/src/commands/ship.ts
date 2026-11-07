/**
 * @fileoverview `ignex ship` — the guided go-live flow.
 *
 * One command from "works on my machine" to "ready to deploy": picks a
 * deployment style (Docker Compose / systemd + Caddy / CI), generates the
 * missing `ignex ops` artifacts WITHOUT clobbering existing files, fills the
 * project's declared secrets into `.env` (generated values — never
 * overwriting what the operator set), scaffolds the `/ready` probe when
 * missing, optionally runs the production build, and finishes with the
 * read-only go-live checklist (`ignex doctor --golive` semantics). The
 * write layer lives in `./ship-artifacts.ts`.
 *
 * Non-TTY runs accept flags + `--yes` (CI-safe defaults); `--check` is the
 * read-only gating run.
 */
import { spawnSync } from "node:child_process";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { resolveProjectRoot } from "../utils/discover-root.js";
import {
  collectGoliveChecks,
  type GoliveItem,
  hasBlocking,
  renderGolive,
  resolveProjectName,
} from "../utils/golive.js";
import { error, info, step, warn } from "../utils/logger.js";
import { PromptCancelError, promptSelect, promptText } from "../utils/prompt.js";
import { metaFor } from "./registry.js";
import {
  ensureEnvFile,
  ensureReadyRoute,
  fillSecrets,
  flagOptions,
  generateArtifacts,
  isShipStyle,
  printShipNextSteps,
  SHIP_STYLES,
  type ShipOptions,
  type ShipStyle,
} from "./ship-artifacts.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  root: { type: "string", valueHint: "dir", description: "Project root" },
  style: {
    type: "string",
    valueHint: "docker|systemd|ci",
    description: "Deployment style (interactive picker when omitted on a TTY)",
  },
  domain: { type: "string", valueHint: "domain", description: "Public domain (Caddyfile + env)" },
  "deploy-host": { type: "string", valueHint: "user@host", description: "CI deploy target" },
  "deploy-dir": { type: "string", valueHint: "dir", description: "CI deploy directory" },
  port: { type: "string", valueHint: "port", description: "App port (default 3000)" },
  "health-path": { type: "string", valueHint: "path", description: "Health check path" },
  user: {
    type: "string",
    valueHint: "user",
    description: "System user for the systemd unit (default: the project name)",
  },
  "app-dir": {
    type: "string",
    valueHint: "dir",
    description: "Absolute checkout path baked into the systemd unit (default: --root)",
  },
  bun: {
    type: "string",
    valueHint: "path",
    description: "Bun binary path on the target host (default: /usr/local/bin/bun)",
  },
  force: { type: "boolean", description: "Overwrite existing generated files" },
  build: { type: "boolean", description: "Run `bun run build` after generating" },
  check: {
    type: "boolean",
    description: "Pre-flight checklist only — write nothing",
  },
  yes: { type: "boolean", description: "Skip interactive prompts (use defaults)" },
  "dry-run": { type: "boolean", description: "Print what would be written; change nothing" },
} satisfies ArgsDef;

const shipCmd = defineCommand({
  meta: metaFor("ship"),
  args: argsDef,
  async run(ctx) {
    await runShip(ctx.rawArgs);
  },
});

export default shipCmd;

/**
 * The `--check` branch: read-only pre-flight, exit 1 on blocking items.
 */
async function runPreflightCheck(
  root: string,
  port: number,
  healthPath: string | undefined,
): Promise<void> {
  const items = await collectGoliveChecks({ root, port, healthPath });
  for (const line of renderGolive(items)) console.log(line);
  if (hasBlocking(items)) process.exitCode = 1;
}

/**
 * Resolve the deployment style: `--style` flag (validated) → interactive
 * picker → `docker` default. Sets the exit code and returns undefined on an
 * invalid flag; returns undefined after a Ctrl+C cancel.
 */
async function resolveShipStyle(
  parsed: ReturnType<typeof parseArgs<typeof argsDef>>,
  interactive: boolean,
): Promise<ShipStyle | undefined> {
  const raw = parsed.style as string | undefined;
  if (raw !== undefined) {
    if (!isShipStyle(raw)) {
      error(`Unknown --style "${raw}". Expected one of: ${SHIP_STYLES.join(", ")}.`);
      process.exitCode = 1;
      return undefined;
    }
    return raw;
  }
  if (!interactive) return "docker";
  try {
    const answered = await promptSelect({
      message: "How will this app run in production?",
      options: [
        {
          value: "docker",
          label: "Docker Compose",
          hint: "containers for app + infra, Caddy in front",
        },
        {
          value: "systemd",
          label: "systemd + Caddy (bare host)",
          hint: "units, deploy.sh with rollback, host install",
        },
        {
          value: "ci",
          label: "CI-managed",
          hint: "GitHub Actions quality gate + optional SSH deploy",
        },
      ],
      initial: "docker",
    });
    return isShipStyle(answered) ? answered : undefined;
  } catch (err) {
    if (err instanceof PromptCancelError) {
      warn("Cancelled — nothing was written.");
      return undefined;
    }
    throw err;
  }
}

/**
 * Resolve the public domain for styles that need one: flag → interactive
 * prompt → `example.com`. Returns undefined after a Ctrl+C cancel.
 */
async function resolveShipDomain(
  parsed: ReturnType<typeof parseArgs<typeof argsDef>>,
  style: ShipStyle,
  interactive: boolean,
): Promise<string | undefined> {
  const flag = parsed.domain as string | undefined;
  if (flag !== undefined) return flag;
  if (style !== "docker" && style !== "systemd") return "example.com";
  if (!interactive) return "example.com";
  try {
    return await promptText({
      message: "Domain (e.g. api.example.com)",
      initial: "example.com",
    });
  } catch (err) {
    if (err instanceof PromptCancelError) {
      warn("Cancelled — nothing was written.");
      return undefined;
    }
    throw err;
  }
}

/** Run the production build (`--build`), or print the dry-run intent. */
async function maybeRunBuild(
  root: string,
  shouldBuild: boolean,
  dryRun: boolean,
): Promise<boolean> {
  if (!shouldBuild) return true;
  if (dryRun) {
    console.log("  + bun run build (dry run)");
    return true;
  }
  step("Building the production artifact (bun run build)");
  const result = spawnSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    error("Build failed — fix it, then re-run: ignex ship");
    process.exitCode = 1;
    return false;
  }
  return true;
}

/** Print the final checklist (advisory — `ignex ship --check` gates). */
async function printFinalChecklist(root: string, options: ShipOptions): Promise<void> {
  const items: readonly GoliveItem[] = await collectGoliveChecks({
    root,
    port: options.port,
    healthPath: options.healthPath,
    probe: !options.dryRun,
  });
  for (const line of renderGolive(items)) console.log(line);
  if (hasBlocking(items)) {
    warn("Not go-live ready yet — run `ignex ship --check` after fixing the ✖ items.");
  }
}

/**
 * Run `ignex ship`: guided artifact generation + secret fill + checklist.
 *
 * @param args - Raw CLI args.
 */
export async function runShip(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);
  const root = await resolveProjectRoot(parsed.root);
  const interactive = process.stdin.isTTY && !parsed.yes;

  const port = Number(parsed.port ?? 3000);
  if (!Number.isFinite(port)) {
    error(`Invalid --port "${String(parsed.port)}".`);
    process.exitCode = 1;
    return;
  }

  if (parsed.check) {
    await runPreflightCheck(root, port, parsed["health-path"]);
    return;
  }

  const style = await resolveShipStyle(parsed, interactive);
  if (style === undefined) return;
  const domain = await resolveShipDomain(parsed, style, interactive);
  if (domain === undefined) return;

  const projectName = resolveProjectName(root);
  const options: ShipOptions = {
    root,
    style,
    domain,
    port,
    healthPath: parsed["health-path"] ?? "/health",
    projectName,
    user: (parsed.user as string | undefined) ?? projectName,
    appDir: (parsed["app-dir"] as string | undefined) ?? root,
    bunPath: (parsed.bun as string | undefined) ?? "/usr/local/bin/bun",
    ...flagOptions(parsed),
  };

  if (options.dryRun) info("Dry run — printing the plan, changing nothing.\n");
  else step(`Shipping for ${style} deployment`);

  await generateArtifacts(options);
  await ensureEnvFile(root, options.dryRun);
  await fillSecrets(root, options.dryRun);
  await ensureReadyRoute(root, options);
  if (!(await maybeRunBuild(root, Boolean(parsed.build), options.dryRun))) return;

  printShipNextSteps(options);
  await printFinalChecklist(root, options);
}
