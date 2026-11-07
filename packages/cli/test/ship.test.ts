/**
 * Tests for `ignex ship` — the guided go-live flow: artifact generation
 * (skip-if-exists, dry-run), secret filling, `--check` gating, style
 * validation, and the registry/completion wiring.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCommand } from "../src/commands/loaders.js";
import { findCommand } from "../src/commands/registry.js";
import { runShip } from "../src/commands/ship.js";
import { systemdInstallTemplate } from "../src/templates/ops.js";
import { flagsFromArgs } from "../src/utils/completion.js";

/** Create a throwaway target dir for one test. */
function tmpTarget(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-ship-"));
}

/** A minimal scaffold-like project: env schema with a secret + example env. */
function scaffoldBase(root: string): void {
  mkdirSync(join(root, "src", "config"), { recursive: true });
  mkdirSync(join(root, "src", "routes"), { recursive: true });
  writeFileSync(
    join(root, "src", "config", "env.ts"),
    `import { Type, defineEnv } from "@ignex/core/env";

export const envSchema = Type.Object({
  NODE_ENV: Type.String({ default: "development" }),
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
});

export const env = defineEnv(envSchema);
`,
  );
  writeFileSync(join(root, ".env.example"), "SESSION_SECRET=\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ship-demo" }));
}

let savedExitCode: number | undefined;
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe("ignex ship (command wiring)", () => {
  it("is registered with aliases and Ship-group examples", () => {
    const row = findCommand("ship");
    expect(row?.group).toBe("Ship");
    expect(row?.aliases).toContain("golive");
    const golive = findCommand("golive");
    expect(golive?.name).toBe("ship");
  });

  it("exposes --style values and core flags to shell completion", async () => {
    const cmd = await loadCommand("ship");
    const flags = flagsFromArgs((cmd?.args ?? {}) as never);
    expect(flags.some((f) => f.flag === "--style")).toBe(true);
    expect(flags.some((f) => f.flag === "--check")).toBe(true);
    expect(flags.some((f) => f.flag === "--dry-run")).toBe(true);
  });
});

describe("runShip docker style (--yes, non-interactive)", () => {
  it("generates the docker artifact set + fills declared secrets", async () => {
    const root = tmpTarget();
    scaffoldBase(root);
    try {
      await runShip(["--style", "docker", "--domain", "demo.test", "--yes", "--root", root]);

      for (const f of [
        "Dockerfile",
        ".dockerignore",
        "docker-compose.yml",
        ".env.docker",
        "Caddyfile",
      ]) {
        expect(existsSync(join(root, f))).toBe(true);
      }
      // .env bootstrapped from .env.example + the declared secret generated.
      const env = readFileSync(join(root, ".env"), "utf8");
      expect(env).toMatch(/^SESSION_SECRET=[A-Za-z0-9_-]{20,}$/m);
      // Compose env carries a generated SESSION_SECRET too.
      const dockerEnv = readFileSync(join(root, ".env.docker"), "utf8");
      expect(dockerEnv).toMatch(/^SESSION_SECRET=.+$/m);
      // /ready probe scaffolded.
      expect(existsSync(join(root, join("src", "routes", "ready.get.ts")))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it("never clobbers existing artifacts without --force", async () => {
    const root = tmpTarget();
    scaffoldBase(root);
    writeFileSync(join(root, "Dockerfile"), "# hand-edited\n");
    try {
      await runShip(["--style", "docker", "--domain", "demo.test", "--yes", "--root", root]);
      expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe("# hand-edited\n");
      // --force does overwrite.
      await runShip([
        "--style",
        "docker",
        "--domain",
        "demo.test",
        "--yes",
        "--force",
        "--root",
        root,
      ]);
      expect(readFileSync(join(root, "Dockerfile"), "utf8")).not.toBe("# hand-edited\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it("respects an already-set secret (kept, not regenerated)", async () => {
    const root = tmpTarget();
    scaffoldBase(root);
    writeFileSync(join(root, ".env"), "SESSION_SECRET=i-set-this\n");
    try {
      await runShip(["--style", "docker", "--yes", "--root", root]);
      expect(readFileSync(join(root, ".env"), "utf8")).toContain("i-set-this");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it("dry-run writes nothing", async () => {
    const root = tmpTarget();
    scaffoldBase(root);
    try {
      await runShip(["--style", "docker", "--yes", "--dry-run", "--root", root]);
      expect(existsSync(join(root, "Dockerfile"))).toBe(false);
      expect(existsSync(join(root, ".env"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe("runShip systemd style", () => {
  it("emits units, deploy.sh (executable), install.sh (executable) and env template", async () => {
    const root = tmpTarget();
    scaffoldBase(root);
    try {
      await runShip(["--style", "systemd", "--domain", "demo.test", "--yes", "--root", root]);

      expect(existsSync(join(root, "deploy", "ship-demo.service"))).toBe(true);
      const deploySh = readFileSync(join(root, "deploy", "deploy.sh"), "utf8");
      expect(deploySh).toContain("set -euo pipefail");
      const installSh = readFileSync(join(root, "deploy", "install.sh"), "utf8");
      expect(installSh).toContain("systemctl daemon-reload");
      expect(existsSync(join(root, "deploy", "env.production.example"))).toBe(true);
      // Infra unit only when a compose file exists (none here).
      expect(existsSync(join(root, "deploy", "ship-demo-infra.service"))).toBe(false);
      // Executable bits.
      expect(statSync(join(root, "deploy", "deploy.sh")).mode & 0o111).toBeTruthy();
      expect(statSync(join(root, "deploy", "install.sh")).mode & 0o111).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe("runShip --check (gating pre-flight)", () => {
  it("exits 1 with blocking items and 0 once they are fixed", async () => {
    const root = tmpTarget();
    scaffoldBase(root);
    savedExitCode = process.exitCode;
    try {
      await runShip(["--check", "--root", root]);
      expect(process.exitCode).toBe(1);

      // Fix: write the build artifact path doctor looks for + a filled secret.
      mkdirSync(join(root, ".ignex"), { recursive: true });
      writeFileSync(join(root, join(".ignex", "server.js")), "export {}\n");
      writeFileSync(join(root, ".env"), "SESSION_SECRET=fixed\n");
      process.exitCode = savedExitCode;
      await runShip(["--check", "--root", root]);
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe("runShip validation", () => {
  it("rejects an unknown --style", async () => {
    const root = tmpTarget();
    savedExitCode = process.exitCode;
    try {
      await runShip(["--style", "carrier-pigeon", "--yes", "--root", root]);
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid --port", async () => {
    const root = tmpTarget();
    savedExitCode = process.exitCode;
    try {
      await runShip(["--check", "--port", "not-a-port", "--root", root]);
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("systemdInstallTemplate", () => {
  it("is a root-guarded, idempotent, dry-run-capable installer", () => {
    const script = systemdInstallTemplate({
      name: "acme",
      user: "acme",
      appDir: "/srv/acme",
      port: 3000,
      healthPath: "/health",
      domain: "api.acme.com",
    });
    expect(script).toContain('SERVICE="acme"');
    expect(script).toContain('APP_DIR="/srv/acme"');
    expect(script).toContain("require_root");
    expect(script).toContain("useradd --system");
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain("sudo deploy/deploy.sh");
    expect(script).toContain("caddy validate --config ./Caddyfile");
    expect(script).toContain("/etc/caddy/Caddyfile.bak.");
    expect(script).toContain("DNS (A/AAAA for api.acme.com)");
    // Shell-variable references must be brace-free (the template literal
    // would otherwise interpolate them as JS bindings).
    expect(script).not.toMatch(/\$\{SERVICE\}|\$\{APP_DIR\}|\$\{APP_USER\}/);
  });
});
