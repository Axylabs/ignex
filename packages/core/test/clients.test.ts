/**
 * ClientRegistry tests — published SDK + frontend-client tracking with git
 * tags. Uses a scratch git repo (created under the workspace) so the
 * `git for-each-ref` probe is exercised for real.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientRegistry } from "../src/debug/clients.js";

const scratchDirs: string[] = [];

/** Create a scratch dir + package.json (and optionally init a git repo). */
const scratch = (files: Record<string, string>, git = false): { dir: string; pkgPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-clients-"));
  scratchDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(abs, content);
  }
  if (git) {
    const run = (args: string[]): void => {
      const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    };
    run(["init", "-q", "-b", "main"]);
    run(["add", "-A"]);
    run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  }
  return { dir, pkgPath: join(dir, "package.json") };
};

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs.length = 0;
});

describe("ClientRegistry", () => {
  it("probes package.json files and reports local-only state without git", () => {
    const { dir, pkgPath } = scratch({
      "package.json": JSON.stringify({ name: "@acme/api-sdk", version: "1.2.3" }),
    });
    const registry = new ClientRegistry({ cwd: dir });
    const clients = registry.list([pkgPath]);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.name).toBe("@acme/api-sdk");
    expect(clients[0]?.version).toBe("1.2.3");
    expect(clients[0]?.kind).toBe("sdk");
    expect(clients[0]?.published).toBe("local");
    expect(clients[0]?.gitTags).toEqual([]);
  });

  it("detects frontend clients via kind/platform metadata (flatbuffers)", () => {
    const { pkgPath } = scratch({
      "package.json": JSON.stringify({
        name: "@acme/api-client",
        version: "0.5.0",
        kind: "client",
        platform: "flatbuffers",
        files: ["dist", "schema.fbs"],
      }),
    });
    const registry = new ClientRegistry({ cwd: "/" });
    const client = registry.list([pkgPath])[0];
    expect(client?.kind).toBe("client");
    expect(client?.platform).toBe("flatbuffers");
    expect(client?.files).toContain("schema.fbs");
  });

  it("probes directories and sdk.json metadata files", () => {
    const { dir } = scratch({
      "sdk.json": JSON.stringify({
        name: "@acme/api-sdk",
        version: "3.0.0",
        platform: "typescript",
      }),
    });
    const registry = new ClientRegistry({ cwd: "/" });
    const clients = registry.list([dir]);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.name).toBe("@acme/api-sdk");
    expect(clients[0]?.platform).toBe("typescript");
  });

  it("lists git tags matching the prefix with dates, newest first", () => {
    const { dir, pkgPath } = scratch(
      {
        "package.json": JSON.stringify({ name: "@acme/api-sdk", version: "1.2.3" }),
      },
      true,
    );
    const tag = (name: string, date: string): void => {
      const res = spawnSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", name, "-m", name],
        { cwd: dir, encoding: "utf8" },
      );
      if (res.status !== 0) throw new Error(res.stderr);
      // Rewrite the tag date so ordering is deterministic.
      const fmt = (d: string): string =>
        new Date(d)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d+Z$/, " +0000");
      const update = spawnSync("git", ["tag", "-f", name, "-m", name], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GIT_COMMITTER_DATE: date },
      });
      if (update.status !== 0) throw new Error(update.stderr);
      void fmt;
    };
    tag("sdk-v0.1.0", "2026-01-01T00:00:00+00:00");
    tag("sdk-v0.2.0", "2026-03-01T00:00:00+00:00");
    tag("v0.1.0", "2026-02-01T00:00:00+00:00"); // different prefix → ignored

    const registry = new ClientRegistry({ cwd: dir });
    const gitTags = registry.gitTags();
    expect(gitTags.map((t) => t.tag)).toEqual(["sdk-v0.2.0", "sdk-v0.1.0"]);

    const client = registry.list([pkgPath])[0];
    expect(client?.gitTags).toEqual(["sdk-v0.2.0", "sdk-v0.1.0"]);
    expect(client?.latestTag).toBe("sdk-v0.2.0");
    expect(client?.published).toBe("tagged");
  });

  it("caches tags and refreshes on demand", () => {
    const { dir, pkgPath } = scratch(
      { "package.json": JSON.stringify({ name: "@acme/api-sdk", version: "1.0.0" }) },
      true,
    );
    const registry = new ClientRegistry({ cwd: dir, cacheMs: 60_000 });
    expect(registry.list([pkgPath])[0]?.published).toBe("local");

    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "tag", "sdk-v1.0.0"], {
      cwd: dir,
      encoding: "utf8",
    });
    // Still cached → local.
    expect(registry.list([pkgPath])[0]?.published).toBe("local");
    registry.refresh();
    expect(registry.list([pkgPath])[0]?.published).toBe("tagged");
  });

  it("reports a git error without crashing when git is unavailable", () => {
    const { dir, pkgPath } = scratch({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
    });
    const registry = new ClientRegistry({ cwd: dir, tagPrefixes: ["sdk-v"] });
    // cwd is not a git repo — git for-each-ref fails gracefully.
    const clients = registry.list([pkgPath]);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.published).toBe("local");
    expect(registry.error).toBeTruthy();
  });
});
