/**
 * @fileoverview `ignex ship` — the guided go-live flow.
 *
 * One command from "works on my machine" to "ready to deploy": picks a
 * deployment style (Docker Compose / systemd + Caddy / CI), generates the
 * missing `ignex ops` artifacts WITHOUT clobbering existing files, fills the
 * project's declared secrets into `.env` (generated values — never
 * overwriting what the operator set), scaffolds the `/ready` probe when
 * missing, optionally runs the production build, and finishes with the
 * read-only go-live checklist (`ignex doctor --golive` semantics).
 *
 * Ship never touches `/etc` or runs sudo itself — host provisioning goes
 * through the generated `deploy/install.sh`, keeping it a deliberate,
 * scriptable act. Non-TTY runs accept flags + `--yes` (CI-safe defaults).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import {
  caddyfileTemplate,
  ciWorkflowTemplate,
  composeTemplate,
  dockerEnvTemplate,
  dockerfileTemplate,
  dockerignoreTemplate,
  envProductionTemplate,
  systemdDeployTemplate,
  systemdInfraUnitTemplate,
  systemdInstallTemplate,
  systemdUnitTemplate,
} from "../templates/ops.js";
import { readyRouteTemplate } from "../templates/routes-prod.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { fillEnvSecrets, listSecretVars, unfilledSecretKeys } from "../utils/env-fill.js";
import { exists, readTextFile } from "../utils/fs.js";
import {
  collectGoliveChecks,
  type GoliveItem,
  hasBlocking,
  renderGolive,
  resolveProjectName,
} from "../utils/golive.js";
import { error, info, step, warn } from "../utils/logger.js";
import { PromptCancelError, promptSelect, promptText } from "../utils/prompt.js";
import { writeScaffold } from "../utils/scaffold.js";
import { generateSecret } from "../utils/secrets.js";
import { metaFor } from "./registry.js";

/** Deployment styles `ignex ship` can prepare. */
export const SHIP_STYLES = ["docker", "systemd", "ci"] as const;
export type ShipStyle = (typeof SHIP_STYLES)[number];

const isStyle = (value: string): value is ShipStyle =>
  (SHIP_STYLES as readonly string[]).includes(value);

/** Default CI image for the generated workflow (a literal GitHub expression). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
const CI_IMAGE = "ghcr.io/${{ github.repository }}";

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

/** Resolved, prompt-free inputs the generators and plan share. */
interface ShipOptions {
  root: string;
  style: ShipStyle;
  domain: string;
  port: number;
  healthPath: string;
  projectName: string;
  user: string;
  appDir: string;
  bunPath: string;
  deployHost: string;
  deployDir: string;
  image: string;
  force: boolean;
  dryRun: boolean;
}

/**
 * Write one ship artifact behind the skip-if-exists gate (silent skip — the
 * summary and checklist report what was left untouched). Dry-run prints the
 * intent instead of writing.
 *
 * @returns True when the file was written (false on skip or dry-run).
 */
async function writeShipFile(
  root: string,
  relPath: string,
  content: string,
  options: Pick<ShipOptions, "force" | "dryRun">,
  mode?: number,
): Promise<boolean> {
  if (options.dryRun) {
    console.log(`  + ${relPath} (dry run)`);
    return false;
  }
  return writeScaffold(join(root, relPath), content, { force: options.force, mode });
}

/**
 * Generate the artifacts for one style. Existing files are never clobbered
 * without `--force`; generated secrets (compose credentials,
 * SESSION_SECRET) are created fresh and written into `.env.docker` only.
 */
async function generateArtifacts(options: ShipOptions): Promise<void> {
  const { root, style, domain, port, healthPath, projectName } = options;
  const unitOpts = {
    name: projectName,
    user: options.user,
    appDir: options.appDir,
    bunPath: options.bunPath,
    port,
    healthPath,
    domain,
  };

  if (style === "docker") {
    step("Docker deploy artifacts");
    await writeShipFile(root, "Dockerfile", dockerfileTemplate({ port, healthPath }), options);
    await writeShipFile(root, ".dockerignore", dockerignoreTemplate(), options);
    const dbPassword = generateSecret();
    const sessionSecret = generateSecret(32);
    const composeOpts = {
      port,
      healthPath,
      services: ["mongo"] as const,
      dbPassword,
      sessionSecret,
    };
    await writeShipFile(root, "docker-compose.yml", composeTemplate(composeOpts), options);
    await writeShipFile(root, ".env.docker", dockerEnvTemplate(composeOpts), options);
    info("Generated MongoDB credentials + SESSION_SECRET into .env.docker — keep it out of git.");
  }

  if (style === "docker" || style === "systemd") {
    step("TLS proxy");
    await writeShipFile(
      root,
      "Caddyfile",
      caddyfileTemplate({ domains: [domain], upstream: `127.0.0.1:${port}` }),
      options,
    );
  }

  if (style === "systemd") {
    step("systemd units + deploy scripts");
    const withInfra = existsSync(join(root, "docker-compose.yml"));
    await writeShipFile(
      root,
      join("deploy", `${projectName}.service`),
      systemdUnitTemplate({ ...unitOpts, withInfra }),
      options,
    );
    if (withInfra) {
      await writeShipFile(
        root,
        join("deploy", `${projectName}-infra.service`),
        systemdInfraUnitTemplate({
          name: projectName,
          workDir: options.appDir,
          composeFile: join(options.appDir, "docker-compose.yml"),
        }),
        options,
      );
    }
    await writeShipFile(
      root,
      join("deploy", "deploy.sh"),
      systemdDeployTemplate({
        ...unitOpts,
        withInfra,
        composeFile: join(options.appDir, "docker-compose.yml"),
        migrate: false,
      }),
      options,
      0o755,
    );
    await writeShipFile(
      root,
      join("deploy", "install.sh"),
      systemdInstallTemplate(unitOpts),
      options,
      0o755,
    );
    await writeShipFile(
      root,
      join("deploy", "env.production.example"),
      envProductionTemplate({ publicBaseUrl: `https://${domain}` }),
      options,
    );
  }

  if (style === "ci") {
    step("CI workflow");
    await writeShipFile(
      root,
      join(".github", "workflows", "ci.yml"),
      ciWorkflowTemplate({
        image: options.image,
        deployHost: options.deployHost,
        deployDir: options.deployDir,
      }),
      options,
    );
  }
}

/** Copy `.env.example` → `.env` when the project has no `.env` yet. */
async function ensureEnvFile(root: string, dryRun: boolean): Promise<boolean> {
  if (await exists(join(root, ".env"))) return true;
  if (!(await exists(join(root, ".env.example")))) return false;
  if (dryRun) {
    console.log("  + .env (dry run — copy of .env.example)");
    return false;
  }
  copyFileSync(join(root, ".env.example"), join(root, ".env"));
  info("Created .env from .env.example.");
  return true;
}

/** Fill declared-but-empty secrets in `.env`; report generated vs kept. */
async function fillSecrets(root: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    const keys = await listSecretVars(root);
    if (keys.length === 0) return;
    const envPath = join(root, ".env");
    const lines = existsSync(envPath)
      ? (await readTextFile(envPath)).replace(/\r\n/g, "\n").split("\n")
      : [];
    const missing = unfilledSecretKeys(lines, keys);
    if (missing.length > 0) {
      console.log(`  + .env secrets (dry run): would generate ${missing.join(", ")}`);
    }
    return;
  }
  const fill = await fillEnvSecrets(root, ".env");
  if (fill === null) return;
  if (fill.filled.length > 0) info(`Generated secrets into .env: ${fill.filled.join(", ")}`);
  if (fill.kept.length > 0) info(`Kept existing secrets: ${fill.kept.join(", ")}`);
}

/** Scaffold the readiness route when the project lacks it. */
async function ensureReadyRoute(
  root: string,
  options: Pick<ShipOptions, "force" | "dryRun">,
): Promise<void> {
  const path = join(root, "src", "routes", "ready.get.ts");
  if (await exists(path)) return;
  await writeShipFile(root, join("src", "routes", "ready.get.ts"), readyRouteTemplate(), options);
}

/** Style-specific hand-off commands, printed before the final checklist. */
function printShipNextSteps(options: ShipOptions): void {
  console.log();
  console.log("Next steps:");
  if (options.style === "systemd") {
    console.log("  sudo ./deploy/install.sh            # system user + units + enable");
    console.log("  sudo ./deploy/install.sh --caddy    # also install the Caddyfile (TLS)");
    console.log("  sudo ./deploy/deploy.sh             # deps → build → start → health-verified");
    console.log(`  DNS: point ${options.domain} at this host`);
  } else if (options.style === "docker") {
    console.log("  docker compose up -d --build        # reads secrets from .env.docker");
    console.log(`  DNS: point ${options.domain} here, then: caddy run --config Caddyfile`);
  } else {
    console.log(
      "  git push                            # quality gate (+ deploy when --deploy-host)",
    );
    if (options.deployHost) {
      console.log(`  Add the DEPLOY_SSH_KEY GitHub secret for ${options.deployHost}`);
    }
  }
  console.log();
}

/**
 * The `--check` branch: read-only pre-flight, exit 1 on blocking items.
 *
 * @returns True when the caller should stop (check mode ran).
 */
async function runPreflightCheck(
  root: string,
  port: number,
  healthPath: string | undefined,
): Promise<boolean> {
  const items = await collectGoliveChecks({ root, port, healthPath });
  for (const line of renderGolive(items)) console.log(line);
  if (hasBlocking(items)) process.exitCode = 1;
  return true;
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
    if (!isStyle(raw)) {
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
    return isStyle(answered) ? answered : undefined;
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
    deployHost: (parsed["deploy-host"] as string | undefined) ?? "",
    deployDir: (parsed["deploy-dir"] as string | undefined) ?? "/opt/ignex-app",
    image: CI_IMAGE,
    force: Boolean(parsed.force),
    dryRun: Boolean(parsed["dry-run"]),
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
