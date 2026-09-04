/**
 * Tests for `ignex create` — focused on the `--root` target directory flag
 * (defaults, traversal guard) rather than the full scaffold surface.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      // The `openapi` feature now installs the `openapi()` plugin (app.config)
      // instead of a broken `openapi.json.get.ts` route that served an empty spec.
      expect(existsSync(join(target, "src/routes/openapi.json.get.ts"))).toBe(false);
      expect(existsSync(join(target, "src/app.config.ts"))).toBe(true);
      expect(readFileSync(join(target, "src/app.config.ts"), "utf8")).toContain("openapi()");
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
});
