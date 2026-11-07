/**
 * @fileoverview Process-level CLI e2e — spawns the real binary entry
 * (`bun packages/cli/src/index.ts`) as a child process and asserts exit codes
 * plus stdout/file output: `route:list --json` against a materialized compiler
 * fixture, `ops caddy` with explicit flags (its generated Caddyfile is the
 * pinned-line artifact; stdout only carries the Created notice), and
 * `--help`/`-h` usage. Every spawn runs in a throwaway temp dir cleaned up in
 * `afterAll`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { materializeFixture } from "../../compiler/test/helpers";

/** Repo root — the test file lives at <root>/packages/cli/test/. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The CLI entry citty dispatches from (package.json `bin` wraps the same file). */
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

const ENTRY_EXISTS = existsSync(CLI_ENTRY);

/** Hard ceiling for one CLI invocation (a Bun cold start is well under 5s). */
const SPAWN_TIMEOUT_MS = 20_000;

interface CliRun {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI binary as a child process; stdin is /dev/null (non-interactive). */
const runCli = async (args: string[], cwd: string): Promise<CliRun> =>
  new Promise<CliRun>((resolve, reject) => {
    const child = spawn("bun", [CLI_ENTRY, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(
          new Error(`CLI spawn timed out after ${SPAWN_TIMEOUT_MS}ms: ignex ${args.join(" ")}`),
        );
      }
    }, SPAWN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      }
    });
  });

/** Temp dirs created by these tests — removed once the suite settles. */
const tempDirs: string[] = [];
const track = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe.skipIf(!ENTRY_EXISTS)("ignex CLI process e2e", () => {
  it("route:list prints the materialized fixture's routes as JSON, exit 0", async () => {
    const layout = materializeFixture("basic");
    track(layout.outDir);
    // The compiler helper materializes routes at <root>/routes; route:list's
    // no-manifest fallback reads the conventional <root>/src/routes.
    mkdirSync(join(layout.outDir, "src"), { recursive: true });
    renameSync(layout.routesDir, join(layout.outDir, "src", "routes"));

    const run = await runCli(["route:list", "--json", "--root", layout.outDir], layout.outDir);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    const rows = JSON.parse(run.stdout.trim()) as Array<{ method: string; path: string }>;
    const paths = rows.map((r) => r.path);
    expect(paths).toContain("/");
    expect(paths).toContain("/about");
    expect(paths).toContain("/echo");
    expect(paths).toContain("/health");
    expect(rows.find((r) => r.path === "/echo")?.method).toBe("POST");
  });

  it("ops caddy generates a Caddyfile with the pinned proxy lines, exit 0", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "ignex-cli-e2e-caddy-")));
    const run = await runCli(
      [
        "ops",
        "caddy",
        "--root",
        dir,
        "--domain",
        "test.example.com",
        "--upstream",
        "127.0.0.1:4321",
        "--max-body",
        "64MiB",
        "--lb-retry",
        "5s",
      ],
      dir,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Created Caddyfile");

    // The generated Caddyfile is the command's output artifact (stdout only
    // carries the notice); the pinned lines must appear verbatim.
    const caddyfile = readFileSync(join(dir, "Caddyfile"), "utf8");
    expect(caddyfile).toContain("header_up X-Real-IP {remote_host}");
    expect(caddyfile).toContain("max_size 64MiB");
    expect(caddyfile).toContain("lb_try_duration 5s");
    expect(caddyfile).toContain("test.example.com");
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:4321");
  });

  it("--help prints the usage banner, exit 0", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "ignex-cli-e2e-help-")));
    const run = await runCli(["--help"], dir);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("USAGE");
    expect(run.stdout).toContain("ignex");
    expect(run.stdout).toContain("COMMANDS");
  });

  it("-h prints the usage banner, exit 0", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "ignex-cli-e2e-h-")));
    const run = await runCli(["-h"], dir);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("USAGE");
  });
});
