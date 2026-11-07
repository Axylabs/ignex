/**
 * Tests for `utils/golive` — the read-only go-live checklist: check
 * collection (env, secrets, build, health probe, units, caddy), rendering,
 * and the shared project-name resolver.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectGoliveChecks,
  hasBlocking,
  renderGolive,
  resolveProjectName,
} from "../src/utils/golive.js";

/** Create a throwaway project dir for one test. */
function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-golive-"));
}

/** A scaffold-like project: env schema with a secret + example env. */
function scaffoldBase(root: string): void {
  mkdirSync(join(root, "src", "config"), { recursive: true });
  writeFileSync(
    join(root, "src", "config", "env.ts"),
    `import { Type, defineEnv } from "@ignex/core/env";

export const envSchema = Type.Object({
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
});

export const env = defineEnv(envSchema);
`,
  );
  writeFileSync(join(root, ".env.example"), "SESSION_SECRET=\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "golive-demo" }));
}

describe("resolveProjectName", () => {
  it("prefers package.json name, falls back to the directory", () => {
    const root = tmpProject();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@acme/api" }));
    try {
      expect(resolveProjectName(root)).toBe("@acme/api");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the directory basename without a package.json", () => {
    const root = join(tmpProject(), "my-app");
    mkdirSync(root, { recursive: true });
    try {
      expect(resolveProjectName(root)).toBe("my-app");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectGoliveChecks (hermetic, --no-probe shape)", () => {
  it("reports the full ordered checklist for a bare scaffold", async () => {
    const root = tmpProject();
    scaffoldBase(root);
    try {
      const items = await collectGoliveChecks({ root, probe: false });

      expect(items.map((i) => i.id)).toEqual([
        "env",
        "secrets",
        "build",
        "health",
        "units",
        "caddy",
      ]);
      expect(items.find((i) => i.id === "env")?.status).toBe("warn");
      // SESSION_SECRET absent from .env → blocking, with the fix command.
      const secrets = items.find((i) => i.id === "secrets");
      expect(secrets?.status).toBe("fail");
      expect(secrets?.detail).toContain("SESSION_SECRET");
      expect(secrets?.fix).toContain("ignex ship");
      expect(items.find((i) => i.id === "build")?.status).toBe("fail");
      expect(items.find((i) => i.id === "build")?.fix).toBe("ignex build");
      // Probe skipped → advisory, not blocking.
      expect(items.find((i) => i.id === "health")?.status).toBe("warn");
      expect(hasBlocking(items)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("goes green on env/secrets/build once they exist", async () => {
    const root = tmpProject();
    scaffoldBase(root);
    writeFileSync(join(root, ".env"), "SESSION_SECRET=set\n");
    mkdirSync(join(root, ".ignex"), { recursive: true });
    writeFileSync(join(root, ".ignex", "server.js"), "export {}\n");
    try {
      const items = await collectGoliveChecks({ root, probe: false });
      expect(items.find((i) => i.id === "env")?.status).toBe("pass");
      expect(items.find((i) => i.id === "secrets")?.status).toBe("pass");
      expect(items.find((i) => i.id === "build")?.status).toBe("pass");
      expect(hasBlocking(items)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks secrets as passing when the schema declares none", async () => {
    const root = tmpProject();
    try {
      const items = await collectGoliveChecks({ root, probe: false });
      const secrets = items.find((i) => i.id === "secrets");
      expect(secrets?.status).toBe("pass");
      expect(secrets?.detail).toContain("no secret vars declared");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderGolive", () => {
  it("renders marks, fix hints, and a blocking summary", () => {
    const lines = renderGolive([
      { id: "env", label: ".env present", status: "pass", fix: "" },
      {
        id: "secrets",
        label: "Secrets",
        status: "fail",
        fix: "ignex ship",
        detail: "missing: SESSION_SECRET",
      },
      { id: "caddy", label: "TLS proxy (Caddy)", status: "warn", fix: "ignex ops caddy" },
    ]);
    expect(lines[0]).toBe("Go-live checklist:");
    expect(lines[1]).toContain("✔ .env present");
    expect(lines[2]).toContain("✖ Secrets — missing: SESSION_SECRET");
    expect(lines[3]).toContain("fix: ignex ship");
    expect(lines.at(-1)).toContain("1 blocking");
  });

  it("summarizes ready state when nothing blocks", () => {
    const lines = renderGolive([{ id: "env", label: ".env present", status: "pass", fix: "" }]);
    expect(lines.at(-1)).toBe("ready to go live");
  });
});
