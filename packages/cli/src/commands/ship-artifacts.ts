/**
 * @fileoverview `ignex ship` artifact generation — the write layer of the
 * guided go-live flow, split from `./ship.ts` (size gate): the resolved
 * options shape, the per-style artifact emitters (skip-if-exists, dry-run
 * aware), the `.env` bootstrap + secret fill, the `/ready` scaffolder, and
 * the style-specific next-step hints.
 *
 * Ship never touches `/etc` or runs sudo itself — host provisioning goes
 * through the generated `deploy/install.sh`, keeping it a deliberate,
 * scriptable act.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
import { fillEnvSecrets, listSecretVars, unfilledSecretKeys } from "../utils/env-fill.js";
import { exists, readTextFile } from "../utils/fs.js";
import { info, step } from "../utils/logger.js";
import { writeScaffold } from "../utils/scaffold.js";
import { generateHexSecret, generateSecret } from "../utils/secrets.js";

/** Deployment styles `ignex ship` can prepare. */
export const SHIP_STYLES = ["docker", "systemd", "ci"] as const;
export type ShipStyle = (typeof SHIP_STYLES)[number];

export const isShipStyle = (value: string): value is ShipStyle =>
  (SHIP_STYLES as readonly string[]).includes(value);

/** Default CI image for the generated workflow (a literal GitHub expression). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
const CI_IMAGE = "ghcr.io/${{ github.repository }}";

/** Resolved, prompt-free inputs the generators share. */
export interface ShipOptions {
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

/** The `ShipOptions` fields derived purely from CLI flags. */
export type ShipFlagOptions = Pick<
  ShipOptions,
  "force" | "dryRun" | "deployHost" | "deployDir" | "image"
>;

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
 * without `--force`; generated secrets (compose credentials, SESSION_SECRET)
 * are created fresh and written into `.env.docker` only.
 */
export async function generateArtifacts(options: ShipOptions): Promise<void> {
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
    const sessionSecret = generateHexSecret();
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
export async function ensureEnvFile(root: string, dryRun: boolean): Promise<boolean> {
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
export async function fillSecrets(root: string, dryRun: boolean): Promise<void> {
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
export async function ensureReadyRoute(
  root: string,
  options: Pick<ShipOptions, "force" | "dryRun">,
): Promise<void> {
  const path = join(root, "src", "routes", "ready.get.ts");
  if (await exists(path)) return;
  await writeShipFile(root, join("src", "routes", "ready.get.ts"), readyRouteTemplate(), options);
}

/** Style-specific hand-off commands, printed before the final checklist. */
export function printShipNextSteps(options: ShipOptions): void {
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

/** Build the flag-derived portion of {@link ShipOptions}. */
export function flagOptions(parsed: Record<string, unknown>): ShipFlagOptions {
  return {
    force: Boolean(parsed.force),
    dryRun: Boolean(parsed["dry-run"]),
    deployHost: (parsed["deploy-host"] as string | undefined) ?? "",
    deployDir: (parsed["deploy-dir"] as string | undefined) ?? "/opt/ignex-app",
    image: CI_IMAGE,
  };
}
