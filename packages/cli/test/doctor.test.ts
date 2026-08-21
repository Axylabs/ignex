/**
 * Tests for `ignex doctor` — the report collection and rendering stay pure
 * (no console writes), so they are exercised against throwaway temp projects.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDoctorReport, renderDoctor } from "../src/commands/doctor.js";

/** Create a throwaway temp project dir for one test. */
function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-doctor-"));
}

/** Symlink the workspace `@ignex/core` into a temp project so its env module resolves. */
function linkWorkspaceCore(dir: string): void {
  mkdirSync(join(dir, "node_modules", "@ignex"), { recursive: true });
  symlinkSync(join(process.cwd(), "packages/core"), join(dir, "node_modules", "@ignex/core"));
}

describe("doctor", () => {
  it("reports a missing routes directory as an issue", async () => {
    const dir = tmpProject();
    try {
      const report = await collectDoctorReport(["--root", dir]);
      expect(report.root).toBe(dir);
      expect(report.routes.dir).toBe("src/routes");
      expect(report.routes.exists).toBe(false);
      expect(report.issues.some((issue) => issue.includes("routes directory"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing compiled server as an issue", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src/routes"), { recursive: true });
      const report = await collectDoctorReport(["--root", dir]);
      expect(report.routes.exists).toBe(true);
      expect(report.server.exists).toBe(false);
      expect(report.issues.some((issue) => issue.includes("no compiled server"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects the config file and honors custom outDir/outFile", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src/routes"), { recursive: true });
      mkdirSync(join(dir, "out"), { recursive: true });
      writeFileSync(join(dir, "out", "app.js"), "// built\n");
      writeFileSync(
        join(dir, "ignex.config.json"),
        JSON.stringify({ outDir: "out", outFile: "app.js" }),
      );

      const report = await collectDoctorReport(["--root", dir]);
      expect(report.configFile).toBe("ignex.config.json");
      expect(report.server.path).toBe(join("out", "app.js"));
      expect(report.server.exists).toBe(true);
      expect(report.issues).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports healthy after a config-less build", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src/routes"), { recursive: true });
      mkdirSync(join(dir, ".ignex"), { recursive: true });
      writeFileSync(join(dir, ".ignex", "server.js"), "// built\n");

      const report = await collectDoctorReport(["--root", dir]);
      expect(report.configFile).toBeNull();
      expect(report.routes.exists).toBe(true);
      expect(report.server.exists).toBe(true);
      expect(report.issues).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders every check line", async () => {
    const dir = tmpProject();
    try {
      const report = await collectDoctorReport(["--root", dir]);
      const lines = renderDoctor(report);

      expect(lines.some((line) => line.startsWith("Doctor:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("Runtime:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("Native:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("Config:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("Routes:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("Server:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("Env:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("Security:"))).toBe(true);
      expect(lines.some((line) => line.includes("problem(s) found"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing required env vars as blocking issues", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src/config"), { recursive: true });
      linkWorkspaceCore(dir);
      writeFileSync(
        join(dir, "src/config/env.ts"),
        `import { Type, defineEnv } from "@ignex/core/env";
export const envSchema = Type.Object({ DATABASE_URL: Type.String() });
export const env = defineEnv(envSchema, { loadEnv: false });
`,
      );

      const report = await collectDoctorReport(["--root", dir]);
      expect(report.env.file).toBe("src/config/env.ts");
      expect(report.env.issues.some((i) => i.code === "IGN_ENV_MISSING_REQUIRED")).toBe(true);
      expect(report.issues.some((i) => i.startsWith("env: DATABASE_URL"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces optional env warnings without blocking", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src/config"), { recursive: true });
      linkWorkspaceCore(dir);
      writeFileSync(
        join(dir, "src/config/env.ts"),
        `import { Type, defineEnv } from "@ignex/core/env";
export const envSchema = Type.Object({
  NODE_ENV: Type.String({ default: "development" }),
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
});
export const env = defineEnv(envSchema, { loadEnv: false });
`,
      );

      const report = await collectDoctorReport(["--root", dir]);
      expect(report.env.issues.some((i) => i.code === "IGN_ENV_MISSING_OPTIONAL")).toBe(true);
      expect(report.env.issues.every((i) => i.severity === "warning")).toBe(true);
      // Warnings must not land in the blocking `issues` list.
      expect(report.issues.some((i) => i.startsWith("env:"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no env checks when the module is absent", async () => {
    const dir = tmpProject();
    try {
      const report = await collectDoctorReport(["--root", dir]);
      expect(report.env.file).toBeNull();
      expect(report.env.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags the default session secret as a blocking issue in production", async () => {
    const dir = tmpProject();
    const previous = process.env.NODE_ENV;
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src/app.config.ts"),
        'session({ secret: env.SESSION_SECRET || "dev-secret-change-me" })\n',
      );
      process.env.NODE_ENV = "production";
      const report = await collectDoctorReport(["--root", dir]);
      expect(report.security.defaultSecret).toBe(true);
      expect(report.issues.some((issue) => issue.startsWith("security:"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not block on the default secret outside production", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src/app.config.ts"),
        'session({ secret: env.SESSION_SECRET || "dev-secret-change-me" })\n',
      );
      const report = await collectDoctorReport(["--root", dir]);
      expect(report.security.defaultSecret).toBe(true);
      expect(report.issues.some((issue) => issue.startsWith("security:"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
