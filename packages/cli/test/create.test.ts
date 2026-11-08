/**
 * Tests for `ignex create` — focused on the `--root` target directory flag
 * (defaults, traversal guard) rather than the full scaffold surface.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCreate } from "../src/commands/create.js";

/** Create a throwaway parent dir for one test. */
function tmpParent(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-create-"));
}

describe("ignex create --root", () => {
  it("scaffolds the app under --root instead of cwd", async () => {
    const base = tmpParent();
    try {
      await runCreate([
        "demo",
        "--root",
        base,
        "--features",
        "openapi",
        "--yes",
        "--no-install",
        "--no-git",
      ]);

      const target = join(base, "demo");
      expect(existsSync(join(target, "package.json"))).toBe(true);
      expect(existsSync(join(target, "src/routes/index.get.ts"))).toBe(true);
      // Baseline readiness probe (503 contract) ships with every scaffold.
      expect(existsSync(join(target, "src/routes/ready.get.ts"))).toBe(true);
      expect(readFileSync(join(target, "src/routes/ready.get.ts"), "utf8")).toContain(
        "runReadinessChecks",
      );
      // The `openapi` feature now installs the `openapi()` plugin (app.config)
      // instead of a broken `openapi.json.get.ts` route that served an empty spec.
      expect(existsSync(join(target, "src/routes/openapi.json.get.ts"))).toBe(false);
      expect(existsSync(join(target, "src/app.config.ts"))).toBe(true);
      expect(readFileSync(join(target, "src/app.config.ts"), "utf8")).toContain("openapi()");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("emits feature env vars into the scaffolded schema and .env.example", async () => {
    const base = tmpParent();
    try {
      await runCreate([
        "demo",
        "--root",
        base,
        "--features",
        "metrics,mailer",
        "--yes",
        "--no-install",
        "--no-git",
      ]);

      const target = join(base, "demo");
      const envTs = readFileSync(join(target, "src/config/env.ts"), "utf8");
      expect(envTs).toContain(
        "METRICS_TOKEN: Type.Optional(Type.String({ metadata: { secret: true } }))",
      );
      expect(envTs).toContain("SMTP_HOST: Type.Optional(Type.String())");
      const example = readFileSync(join(target, ".env.example"), "utf8");
      expect(example).toContain("METRICS_TOKEN=");
      expect(example).toContain("SMTP_PASS=");
      // The metrics registry lib + customized plugins wiring land too.
      expect(existsSync(join(target, "src/lib/metrics.ts"))).toBe(true);
      const plugins = readFileSync(join(target, "src/plugins/index.ts"), "utf8");
      expect(plugins).toContain("metricsPlugin({ metrics");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("scaffolds plugin features without a self-shadowing app.config (TDZ regression)", async () => {
    const base = tmpParent();
    try {
      await runCreate([
        "demo",
        "--root",
        base,
        "--features",
        "cors,rateLimit,security,compression,logger,openapi",
        "--yes",
        "--no-install",
        "--no-git",
      ]);

      const target = join(base, "demo");
      // The selected plugin features generate src/plugins/index.ts + the
      // plugins array in src/app.config.ts.
      expect(existsSync(join(target, "src/plugins/index.ts"))).toBe(true);
      const config = readFileSync(join(target, "src/app.config.ts"), "utf8");
      // Regression: `export const plugins = [...plugins]` shadowed the import
      // and crashed at boot with "Cannot access 'plugins' before
      // initialization". The import must be aliased and the export never
      // spread itself.
      expect(config).toContain('import { plugins as appPlugins } from "./plugins/index.js";');
      expect(config).toContain("  ...appPlugins,");
      expect(config).not.toContain("...plugins,");
      // The debugbar dev dashboard is baseline for every scaffold.
      expect(config).toContain("debugbar()");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("scaffolds the validated env config and .env.example for every project", async () => {
    const base = tmpParent();
    try {
      await runCreate([
        "demo",
        "--root",
        base,
        "--features",
        "none",
        "--yes",
        "--no-install",
        "--no-git",
      ]);

      const target = join(base, "demo");
      const envSource = readFileSync(join(target, "src/config/env.ts"), "utf8");
      expect(envSource).toContain('import { Type, defineEnv } from "@ignex/core/env";');
      expect(envSource).toContain("export const env = defineEnv(envSchema);");

      // Even with no features, the baseline app.config ships the debugbar
      // dashboard (dev mode) + session + openapi plugins.
      const config = readFileSync(join(target, "src/app.config.ts"), "utf8");
      expect(config).toContain("debugbar()");
      expect(config).toContain("openapi()");
      expect(config).toContain("session({");

      const example = readFileSync(join(target, ".env.example"), "utf8");
      expect(example).toContain("PORT=3000");
      expect(example).toContain("SESSION_SECRET=");
      expect(example).toContain("# OPTIONAL — NODE_ENV (default: development)");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("wires the --protocol http/https choice into the typed server config", async () => {
    const base = tmpParent();
    try {
      // Plain HTTP selected → server.https: false (typed with ServerConfig).
      await runCreate([
        "http-app",
        "--root",
        base,
        "--features",
        "none",
        "--protocol",
        "http",
        "--yes",
        "--no-install",
        "--no-git",
      ]);
      const httpConfig = readFileSync(join(base, "http-app", "src/app.config.ts"), "utf8");
      expect(httpConfig).toContain("export const server: ServerConfig = {");
      expect(httpConfig).toContain("https: false");
      expect(httpConfig).not.toMatch(/^ {2}h2: true,/m);

      // Default (no --protocol) stays HTTPS (HTTP/1.1 over TLS).
      await runCreate([
        "https-app",
        "--root",
        base,
        "--features",
        "none",
        "--yes",
        "--no-install",
        "--no-git",
      ]);
      const httpsConfig = readFileSync(join(base, "https-app", "src/app.config.ts"), "utf8");
      expect(httpsConfig).toContain("https: true");
      expect(httpsConfig).not.toMatch(/^ {2}h2: true,/m);

      // HTTPS + HTTP/2 opts into `h2: true` (mapped to Bun.serve's http2).
      await runCreate([
        "h2-app",
        "--root",
        base,
        "--features",
        "none",
        "--protocol",
        "https2",
        "--yes",
        "--no-install",
        "--no-git",
      ]);
      const h2Config = readFileSync(join(base, "h2-app", "src/app.config.ts"), "utf8");
      expect(h2Config).toMatch(/^ {2}https: true,/m);
      expect(h2Config).toMatch(/^ {2}h2: true,/m);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects path-traversal project names even with --root", async () => {
    const base = tmpParent();
    const originalExitCode = process.exitCode;
    try {
      await runCreate(["..", "--root", base, "--yes", "--no-install", "--no-git"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(base, { recursive: true, force: true });
    }
  });

  describe("setup trio (bootstrap + provisioner)", () => {
    it("scaffolds setup.sh (executable), setup.bat and scripts/setup.ts", async () => {
      const base = tmpParent();
      try {
        await runCreate([
          "demo",
          "--root",
          base,
          "--features",
          "none",
          "--yes",
          "--no-install",
          "--no-git",
        ]);

        const target = join(base, "demo");
        expect(existsSync(join(target, "setup.sh"))).toBe(true);
        expect(existsSync(join(target, "setup.bat"))).toBe(true);
        expect(existsSync(join(target, "scripts/setup.ts"))).toBe(true);
        // The bootstrap must be runnable as ./setup.sh — the scaffolder has to
        // preserve the executable bit (default write mode would be 0644).
        // POSIX only — Windows files carry no exec bits.
        const mode = statSync(join(target, "setup.sh")).mode & 0o777;
        if (process.platform !== "win32") {
          expect(mode & 0o111).toBe(0o111);
        }
        // The generated package.json wires the provisioner as a script.
        const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        };
        expect(pkg.scripts.setup).toBe("bun scripts/setup.ts");
        // The .bat ships CRLF line endings (cmd.exe mis-parses LF-only files).
        const bat = readFileSync(join(target, "setup.bat"), "utf8");
        expect(bat.includes("\r\n")).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it("emitted scripts/setup.ts --check prints a hermetic detection report", async () => {
      const base = tmpParent();
      try {
        await runCreate([
          "demo",
          "--root",
          base,
          "--features",
          "none",
          "--yes",
          "--no-install",
          "--no-git",
        ]);

        const target = join(base, "demo");
        // Run the EMITTED script — this proves the embedded source (escaped
        // into the template) parses and its detection logic works on this
        // machine. --check installs nothing, so the test stays hermetic.
        const result = spawnSync("bun", [join("scripts", "setup.ts"), "--check"], {
          cwd: target,
          encoding: "utf8",
          timeout: 60_000,
        });
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout) as {
          os: { platform: string; family: string };
          packageManager: string | null;
          tools: Record<string, boolean | string>;
          project: Record<string, boolean>;
        };
        expect(report.os.platform).toBe(process.platform);
        expect(["linux", "mac", "windows"]).toContain(report.os.family);
        expect(report.tools.bun).toContain("v");
        expect(report.project.envExample).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
