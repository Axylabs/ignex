/**
 * @fileoverview Go-live pre-flight — the read-only production checklist.
 *
 * One collector, two consumers: `ignex doctor --golive` renders it as a
 * checklist, and `ignex ship` uses the same items to decide what to generate
 * and which commands to point the operator at. Everything here is read-only —
 * host provisioning stays a deliberate act (`deploy/install.sh`), so a
 * `--golive` run can never mutate the project or the machine.
 *
 * Checks, in order: `.env` present → declared secrets filled → production
 * build on disk → `/health` answers on loopback → systemd units installed →
 * Caddyfile placed. Each non-passing item carries the exact command that
 * fixes it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { listSecretVars, parseEnvAssignments, unfilledSecretKeys } from "./env-fill.js";
import { exists, readTextFile } from "./fs.js";

/** Status of one go-live check. */
export type GoliveStatus = "pass" | "warn" | "fail";

/** One checklist row. */
export interface GoliveItem {
  /** Stable check id (`env`, `secrets`, `build`, `health`, `units`, `caddy`). */
  readonly id: string;
  /** Human-readable label rendered in the checklist. */
  readonly label: string;
  /** Outcome — `fail` blocks go-live (exit code 1), `warn` advises. */
  readonly status: GoliveStatus;
  /** Exact command that fixes a warn/fail; empty when informational. */
  readonly fix: string;
  /** Extra context (missing secret names, probe errors, …). */
  readonly detail?: string;
}

/** Inputs for {@link collectGoliveChecks}. */
export interface GoliveOptions {
  /** Project root directory. */
  readonly root: string;
  /** Override the probed port (default: `PORT` from `.env`, else 3000). */
  readonly port?: number;
  /** Override the health path (default `/health`). */
  readonly healthPath?: string;
  /** Unit/service name (default: package.json name or the directory). */
  readonly name?: string;
  /**
   * Probe `GET /health` over HTTP (default `true`). Tests pass `false` for a
   * hermetic run.
   */
  readonly probe?: boolean;
}

/** Compiler output defaults (parity with `ignex doctor` / the compiler). */
const DEFAULT_OUT_DIR = ".ignex";
const DEFAULT_OUT_FILE = "server.js";
/** How long the /health probe waits before reporting "not responding". */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Read the project name from the target root's package.json — the systemd
 * unit name default. Falls back to the directory basename.
 *
 * Moved here from `commands/ops.ts` so the go-live surface (ops, doctor,
 * ship) shares one resolver.
 */
export function resolveProjectName(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
  } catch {
    // no/unreadable package.json — fall through to the directory name
  }
  const base = root.split(/[\\/]/).filter(Boolean).pop() ?? "ignex-app";
  return base;
}

/**
 * Collect the go-live checklist for a project. Never throws and never
 * writes; individual check failures degrade to warn/fail items.
 *
 * @param options - Root plus optional port/health-path/name/probe overrides.
 * @returns Checklist rows in render order.
 */
export async function collectGoliveChecks(options: GoliveOptions): Promise<readonly GoliveItem[]> {
  const { root } = options;
  const items: GoliveItem[] = [];

  // ── .env ────────────────────────────────────────────────────────────────
  const envPath = join(root, ".env");
  const hasEnv = await exists(envPath);
  items.push(
    hasEnv
      ? { id: "env", label: ".env present", status: "pass", fix: "" }
      : {
          id: "env",
          label: ".env present",
          status: "warn",
          fix: "ignex ship   # copies .env.example and fills secrets",
          detail: "production values belong in .env (mode 600, not committed)",
        },
  );

  // ── declared secrets ────────────────────────────────────────────────────
  const secretVars = await listSecretVars(root);
  if (secretVars.length === 0) {
    items.push({
      id: "secrets",
      label: "Secrets (env schema metadata.secret)",
      status: "pass",
      fix: "",
      detail: "no secret vars declared",
    });
  } else {
    const envLines = hasEnv ? (await readTextFile(envPath)).replace(/\r\n/g, "\n").split("\n") : [];
    const missing = unfilledSecretKeys(envLines, secretVars);
    items.push(
      missing.length === 0
        ? {
            id: "secrets",
            label: "Secrets (env schema metadata.secret)",
            status: "pass",
            fix: "",
            detail: `${secretVars.length} declared`,
          }
        : {
            id: "secrets",
            label: "Secrets (env schema metadata.secret)",
            status: "fail",
            fix: "ignex ship   # generates the missing secrets into .env",
            detail: `missing: ${missing.join(", ")}`,
          },
    );
  }

  // ── production build ────────────────────────────────────────────────────
  const config = await loadConfig(root);
  const outDir = typeof config.outDir === "string" ? config.outDir : DEFAULT_OUT_DIR;
  const outFile = typeof config.outFile === "string" ? config.outFile : DEFAULT_OUT_FILE;
  const serverPath = join(outDir, outFile);
  items.push(
    (await exists(join(root, serverPath)))
      ? { id: "build", label: `Production build (${serverPath})`, status: "pass", fix: "" }
      : {
          id: "build",
          label: `Production build (${serverPath})`,
          status: "fail",
          fix: "ignex build",
        },
  );

  // ── /health on loopback ─────────────────────────────────────────────────
  const envValues = hasEnv
    ? parseEnvAssignments((await readTextFile(envPath)).replace(/\r\n/g, "\n").split("\n"))
    : new Map<string, string>();
  const rawPort = options.port ?? Number(process.env.PORT ?? envValues.get("PORT") ?? 3000);
  const port = Number.isFinite(rawPort) ? rawPort : 3000;
  const healthPath = options.healthPath ?? "/health";
  const healthUrl = `http://127.0.0.1:${port}${healthPath}`;
  items.push(await probeHealth(healthUrl, options.probe !== false));

  // ── systemd units ───────────────────────────────────────────────────────
  const name = options.name ?? resolveProjectName(root);
  const unitPath = `/etc/systemd/system/${name}.service`;
  if (existsSync(unitPath)) {
    items.push({
      id: "units",
      label: `systemd unit installed (${unitPath})`,
      status: "pass",
      fix: "",
    });
  } else {
    const hasDeployDir = await exists(join(root, "deploy", "install.sh"));
    items.push({
      id: "units",
      label: `systemd unit installed (${unitPath})`,
      status: "warn",
      fix: hasDeployDir
        ? "sudo ./deploy/install.sh   # user + units + enable (+ --caddy)"
        : "ignex ops systemd   # then sudo ./deploy/install.sh",
      detail: "only needed for host/VPS deployments (skip for Docker/K8s)",
    });
  }

  // ── Caddyfile ───────────────────────────────────────────────────────────
  const caddyInstalled = existsSync("/etc/caddy/Caddyfile");
  const caddyGenerated = await exists(join(root, "Caddyfile"));
  if (caddyInstalled) {
    items.push({
      id: "caddy",
      label: "Caddyfile installed (/etc/caddy/Caddyfile)",
      status: "pass",
      fix: "",
    });
  } else if (caddyGenerated) {
    items.push({
      id: "caddy",
      label: "Caddyfile installed (/etc/caddy/Caddyfile)",
      status: "warn",
      fix: "sudo ./deploy/install.sh --caddy",
    });
  } else {
    items.push({
      id: "caddy",
      label: "TLS proxy (Caddy)",
      status: "warn",
      fix: "ignex ops caddy --domain <domain>   # then sudo ./deploy/install.sh --caddy",
      detail: "skip when TLS terminates elsewhere (nginx, K8s ingress, …)",
    });
  }

  return items;
}

/**
 * Probe the loopback health endpoint.
 *
 * @param url - The `http://127.0.0.1:<port>/health` URL to poll once.
 * @param probe - False skips the request (hermetic test runs).
 * @returns A `health` checklist row.
 */
async function probeHealth(url: string, probe: boolean): Promise<GoliveItem> {
  if (!probe) {
    return {
      id: "health",
      label: `Health endpoint (${url})`,
      status: "warn",
      fix: "",
      detail: "not probed (--no-probe)",
    };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok
      ? { id: "health", label: `Health endpoint (${url})`, status: "pass", fix: "" }
      : {
          id: "health",
          label: `Health endpoint (${url})`,
          status: "fail",
          fix: "ignex build && bun .ignex/server.js   # then re-check",
          detail: `answered ${res.status}`,
        };
  } catch {
    return {
      id: "health",
      label: `Health endpoint (${url})`,
      status: "warn",
      fix: "start the app (bun run dev, or systemctl start <name>)",
      detail: "not responding — is the app running?",
    };
  }
}

/**
 * Render the checklist as printable lines.
 *
 * @param items - Rows from {@link collectGoliveChecks}.
 * @returns Lines: a header, one row per check (+ fix/detail), a summary.
 */
export function renderGolive(items: readonly GoliveItem[]): string[] {
  const mark = { pass: "✔", warn: "⚠", fail: "✖" } as const;
  const lines: string[] = ["Go-live checklist:"];
  for (const item of items) {
    let line = `  ${mark[item.status]} ${item.label}`;
    if (item.detail) line += ` — ${item.detail}`;
    lines.push(line);
    if (item.status !== "pass" && item.fix) lines.push(`      fix: ${item.fix}`);
  }
  const failed = items.filter((item) => item.status === "fail").length;
  const warned = items.filter((item) => item.status === "warn").length;
  lines.push(
    failed > 0
      ? `${failed} blocking, ${warned} advisory — fix the ✖ items before going live`
      : warned > 0
        ? `ready (with ${warned} advisory item(s))`
        : "ready to go live",
  );
  return lines;
}

/** True when the checklist has blocking (`fail`) items. */
export const hasBlocking = (items: readonly GoliveItem[]): boolean =>
  items.some((item) => item.status === "fail");
