/**
 * Tests for `ignex add` — the "install a feature bundle into an existing app"
 * scaffolder (the counterpart to `ignex create --features …`).
 *
 * Covers the shared feature vocabulary, the pure install planner (file set,
 * dependency closure, plugin bundle), the additive `src/app.config.ts` wiring
 * transform, and an end-to-end run against a throwaway project directory.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAdd } from "../src/commands/add.js";
import { loadCommand } from "../src/commands/loaders.js";
import { findCommand } from "../src/commands/registry.js";
import {
  parseFeatureTokens,
  planInstall,
  withFeatureDependencies,
} from "../src/templates/features.js";
import { appConfigTemplate } from "../src/templates/routes.js";
import { FEATURE_NAMES, type Feature } from "../src/types.js";
import { wireAppConfig } from "../src/utils/app-config-merge.js";
import { addPluginsToModule } from "../src/utils/plugins-module-merge.js";

/** Build a feature set from names without fighting literal types. */
const features = (...names: Feature[]): Set<Feature> => new Set(names);

describe("parseFeatureTokens", () => {
  it("normalizes aliases, whitespace and comma-separated tokens", () => {
    expect([...parseFeatureTokens("auth,refresh").features]).toEqual(["auth", "refresh"]);
    expect([...parseFeatureTokens("upload,websocket").features]).toEqual(["files", "ws"]);
    expect([...parseFeatureTokens(["rate-limit", " session "]).features]).toEqual([
      "rateLimit",
      "sessions",
    ]);
  });

  it("resolves all / none", () => {
    expect([...parseFeatureTokens("all").features]).toEqual([...FEATURE_NAMES]);
    expect(parseFeatureTokens("none").features.size).toBe(0);
  });

  it("collects unknown tokens instead of throwing", () => {
    const { features: parsed, unknown } = parseFeatureTokens("auth,nope");
    expect([...parsed]).toEqual(["auth"]);
    expect(unknown).toEqual(["nope"]);
  });
});

describe("withFeatureDependencies", () => {
  it("pulls auth in when refresh is selected", () => {
    expect([...withFeatureDependencies(features("refresh"))].sort()).toEqual(["auth", "refresh"]);
  });

  it("leaves independent features untouched", () => {
    expect([...withFeatureDependencies(features("sessions"))]).toEqual(["sessions"]);
  });
});

describe("planInstall", () => {
  it("plans the auth bundle as lib + hook + three routes", () => {
    const plan = planInstall(features("auth"));
    expect(plan.files.map((file) => file.path)).toEqual([
      "src/lib/auth.ts",
      "src/hooks/require-auth.ts",
      "src/routes/auth/register.post.ts",
      "src/routes/auth/login.post.ts",
      "src/routes/auth/me.get.ts",
    ]);
    expect(plan.pluginsFile).toBeUndefined();
    expect(plan.wire).toEqual({ plugins: false, middleware: false });
  });

  it("emits the refresh variant of the auth lib when refresh is selected", () => {
    const plan = planInstall(features("refresh"));
    expect(plan.features).toEqual(["auth", "refresh"]);
    const auth = plan.files.find((file) => file.path === "src/lib/auth.ts");
    expect(auth?.content()).toContain("export const refreshTokens");
    expect(plan.files.some((file) => file.path === "src/routes/auth/logout.post.ts")).toBe(true);
  });

  it("produces src/plugins/index.ts and plugin wiring for plugin features", () => {
    const plan = planInstall(features("cors", "security"));
    expect(plan.pluginsFile?.path).toBe("src/plugins/index.ts");
    expect(plan.pluginsFile?.content()).toContain("cors(),\n  security()");
    expect(plan.wire).toEqual({ plugins: true, middleware: false });
  });

  it("lists the middleware bundle files and asks for middleware wiring", () => {
    const plan = planInstall(features("middleware"));
    expect(plan.files.map((file) => file.path)).toContain("src/middleware/index.ts");
    expect(plan.wire).toEqual({ plugins: false, middleware: true });
  });

  it("keeps the tests bundle aligned with the app name", () => {
    const plan = planInstall(features("tests"), "my-api");
    const test = plan.files.find((file) => file.path === "test/app.test.ts");
    expect(test?.content()).toContain('expect(body.name).toBe("my-api")');
  });

  it("tags every file with its owning feature", () => {
    const plan = planInstall(features("auth", "sessions"));
    const session = plan.files.find((file) => file.path === "src/routes/session.get.ts");
    expect(session?.feature).toBe("sessions");
  });

  it("covers every feature without duplicating a path", () => {
    const plan = planInstall(new Set(FEATURE_NAMES));
    expect(plan.features).toEqual([...FEATURE_NAMES]);
    const paths = plan.files.map((file) => file.path);
    expect(paths.length).toBe(new Set(paths).size);
    expect(paths.length).toBeGreaterThan(15);
  });
});

describe("addPluginsToModule", () => {
  const existing = `import { cors } from "@ignex/core";

export const plugins = [
  cors()
];
`;

  it("merges a factory into the import and the plugins array", () => {
    const { content, added } = addPluginsToModule(existing, ["security"]);
    expect(added).toEqual(["security"]);
    expect(content).toContain('import { cors, security } from "@ignex/core";');
    expect(content).toContain("export const plugins = [\n  security(),\n  cors()\n];");
    expect(content.match(/cors\(\)/g)).toHaveLength(1); // one entry, never duplicated
  });

  it("is a no-op when the factory is already registered", () => {
    const { content, added } = addPluginsToModule(existing, ["cors"]);
    expect(added).toEqual([]);
    expect(content).toBe(existing);
  });

  it("fills in an empty plugins module", () => {
    const { content, added } = addPluginsToModule("export const plugins: never[] = [];\n", [
      "rateLimit",
    ]);
    expect(added).toEqual(["rateLimit"]);
    expect(content).toContain('import { rateLimit } from "@ignex/core";');
    expect(content).toContain("export const plugins = [\n  rateLimit(),\n];");
  });

  it("refuses to touch an unrecognizable module", () => {
    const source = "export const other = 1;\n";
    expect(addPluginsToModule(source, ["cors"])).toEqual({ content: source, added: [] });
  });
});

describe("wireAppConfig", () => {
  const base = appConfigTemplate();

  it("adds the plugins import + spread to the plugins array", () => {
    const { content, changes, patchedPluginsArray } = wireAppConfig(base, { plugins: true });
    expect(patchedPluginsArray).toBe(true);
    expect(content).toContain('import { plugins as appPlugins } from "./plugins/index.js";');
    expect(content).toContain("export const plugins = [\n  ...appPlugins,\n");
    expect(changes.length).toBeGreaterThan(0);
  });

  it("is idempotent", () => {
    const once = wireAppConfig(base, { plugins: true }).content;
    const twice = wireAppConfig(once, { plugins: true });
    expect(twice.changes).toEqual([]);
    expect(twice.content).toBe(once);
  });

  it("adds the middleware spread, imports and lifecycle hooks", () => {
    const { content } = wireAppConfig(base, { middleware: true });
    expect(content).toContain('import { middleware } from "./middleware/index.js";');
    expect(content).toContain(
      'import { logRequests, markResponse } from "./middleware/log-requests.js";',
    );
    expect(content).toContain("  ...middleware,");
    expect(content).toContain(
      "export const lifecycle = {\n  beforeHandle: [logRequests(), markResponse()]\n};",
    );
  });

  it("extends an existing lifecycle instead of declaring a second one", () => {
    const source =
      "export const plugins = [\n  a()\n];\n\nexport const lifecycle = {\n  afterHandle: [audit()]\n};\n";
    const { content } = wireAppConfig(source, { middleware: true });
    expect(content.match(/export const lifecycle/g)).toHaveLength(1);
    expect(content).toContain("beforeHandle: [logRequests(), markResponse()],");
    expect(content).toContain("afterHandle: [audit()]");
  });

  it("appends the example hooks to an existing beforeHandle stage", () => {
    const source = "export const lifecycle = {\n  beforeHandle: [tenant()]\n};\n";
    const { content } = wireAppConfig(source, { middleware: true });
    expect(content).toContain("beforeHandle: [tenant(), logRequests(), markResponse()]");
  });

  it("refuses to touch a config with no recognizable plugins array", () => {
    const source = "export const server = {};\n";
    const { content, patchedPluginsArray } = wireAppConfig(source, { plugins: true });
    expect(patchedPluginsArray).toBe(false);
    expect(content).toBe(source);
  });
});

describe("ignex add", () => {
  /** Create a throwaway project dir for one test. */
  const tmpProject = (): string => mkdtempSync(join(tmpdir(), "ignex-cli-add-"));

  it("installs auth + refresh + a plugin into an existing project", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-api" }));
      writeFileSync(join(dir, "src/app.config.ts"), appConfigTemplate());

      await runAdd(["auth,refresh,cors", "--root", dir]);

      expect(existsSync(join(dir, "src/lib/auth.ts"))).toBe(true);
      expect(existsSync(join(dir, "src/hooks/require-auth.ts"))).toBe(true);
      expect(existsSync(join(dir, "src/routes/auth/refresh.post.ts"))).toBe(true);
      expect(readFileSync(join(dir, "src/lib/auth.ts"), "utf8")).toContain(
        "export const refreshTokens",
      );

      expect(existsSync(join(dir, "src/plugins/index.ts"))).toBe(true);
      expect(readFileSync(join(dir, "src/plugins/index.ts"), "utf8")).toContain("cors()");
      const config = readFileSync(join(dir, "src/app.config.ts"), "utf8");
      expect(config).toContain("...appPlugins,");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates plugin factories across runs instead of skipping the module", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/app.config.ts"), appConfigTemplate());

      await runAdd(["cors", "--root", dir]);
      await runAdd(["security", "--root", dir]);

      const module = readFileSync(join(dir, "src/plugins/index.ts"), "utf8");
      expect(module).toContain("cors()");
      expect(module).toContain("security()");
      expect(module).toContain('import { cors, security } from "@ignex/core";');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips existing files unless --force", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src/routes/auth"), { recursive: true });
      writeFileSync(join(dir, "src/routes/auth/login.post.ts"), "// mine\n");

      await runAdd(["auth", "--root", dir]);
      expect(readFileSync(join(dir, "src/routes/auth/login.post.ts"), "utf8")).toBe("// mine\n");

      await runAdd(["auth", "--root", dir, "--force"]);
      expect(readFileSync(join(dir, "src/routes/auth/login.post.ts"), "utf8")).toContain(
        "ctx.body.json",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write anything with --dry-run", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      await runAdd(["auth", "--root", dir, "--dry-run"]);
      expect(existsSync(join(dir, "src/lib/auth.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves app.config.ts alone with --no-wire", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/app.config.ts"), appConfigTemplate());

      await runAdd(["cors", "--root", dir, "--no-wire"]);

      expect(existsSync(join(dir, "src/plugins/index.ts"))).toBe(true);
      expect(readFileSync(join(dir, "src/app.config.ts"), "utf8")).not.toContain("...appPlugins,");
      process.exitCode = 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on an unknown feature", async () => {
    const dir = tmpProject();
    try {
      await runAdd(["nope", "--root", dir]);
      expect(process.exitCode).toBe(1);
      expect(existsSync(join(dir, "src"))).toBe(false);
      process.exitCode = 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry", () => {
  it("declares the add command under Scaffold", async () => {
    const row = findCommand("add");
    expect(row?.name).toBe("add");
    expect(row?.group).toBe("Scaffold");
    expect(findCommand("install")?.name).toBe("add");
  });

  it("documents the add flags in help", async () => {
    const cmd = await loadCommand("add");
    expect(cmd).toBeDefined();
    const { renderCommandHelp } = await import("../src/usage.js");
    const help = await renderCommandHelp(cmd as never);
    expect(help).toContain("--dry-run");
    expect(help).toContain("--force");
    expect(help).toContain("--no-wire");
  });
});
