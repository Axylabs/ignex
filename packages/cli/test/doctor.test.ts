/**
 * Tests for `ignex doctor` — the report collection and rendering stay pure
 * (no console writes), so they are exercised against throwaway temp projects.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDoctorReport, renderDoctor } from "../src/commands/doctor.js";

/** Create a throwaway temp project dir for one test. */
function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-doctor-"));
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
      expect(lines.some((line) => line.includes("problem(s) found"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
