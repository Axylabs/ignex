/**
 * Tests for `ignex ops` — deployment file templates (pure functions) plus the
 * `runOps` command wiring (file writes, prompts-as-flags, error paths).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runOps } from "../src/commands/ops.js";
import { findCommand } from "../src/commands/registry.js";
import {
  caddyfileTemplate,
  composeTemplate,
  dockerEnvTemplate,
  dockerfileTemplate,
  dockerignoreTemplate,
} from "../src/templates/ops.js";
import { parseFlagDocs } from "../src/utils/completion.js";

/** Create a throwaway target dir for one test. */
function tmpTarget(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-ops-"));
}

describe("dockerfileTemplate", () => {
  it("emits the multi-stage builder/production split", () => {
    const code = dockerfileTemplate();
    expect(code).toContain("FROM oven/bun:latest AS builder");
    expect(code).toContain("FROM debian:stable-slim AS production");
    expect(code).toContain("bun run build --compile --binary-outfile server");
    expect(code).toContain('CMD ["./server"]');
  });

  it("targets the ignex runtime contract (port 3000, /health, no NATS/metrics)", () => {
    const code = dockerfileTemplate();
    expect(code).toContain("EXPOSE 3000");
    expect(code).toContain("http://127.0.0.1:3000/health");
    expect(code).toContain("ENV NODE_ENV=production");
    expect(code).toContain("IGNEX_HTTPS=0");
    expect(code).not.toContain("NATS_ENABLED");
    expect(code).not.toContain("METRICS_ENABLED");
  });

  it("runs as a non-root user with a healthcheck", () => {
    const code = dockerfileTemplate();
    expect(code).toContain("groupadd --system app");
    expect(code).toContain("USER app");
    expect(code).toContain(
      "HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5",
    );
    expect(code).toContain("wget -qO-");
  });

  it("honors custom binary, port, and health path", () => {
    const code = dockerfileTemplate({ binary: "api", port: 4444, healthPath: "/live" });
    expect(code).toContain("bun run build --compile --binary-outfile api");
    expect(code).toContain('CMD ["./api"]');
    expect(code).toContain("EXPOSE 4444");
    expect(code).toContain("http://127.0.0.1:4444/live");
  });

  it("gates .npmrc/.env copies behind the private-registry option", () => {
    const plain = dockerfileTemplate();
    expect(plain).toContain("# COPY .npmrc ./");
    expect(plain).not.toContain("\nCOPY .npmrc");

    const withRegistry = dockerfileTemplate({ privateRegistry: true });
    expect(withRegistry).toContain("COPY .npmrc ./");
    expect(withRegistry).toContain("COPY .env ./");
  });
});

describe("composeTemplate", () => {
  it("includes Percona MongoDB with root user env and healthcheck", () => {
    const yaml = composeTemplate({ dbPassword: "s3cret" });
    expect(yaml).toContain("percona/percona-server-mongodb:7.0");
    expect(yaml).toContain("MONGO_INITDB_ROOT_USERNAME");
    expect(yaml).toContain("MONGO_INITDB_ROOT_PASSWORD");
    expect(yaml).toContain("mongo-data:/data/db");
    expect(yaml).toContain("mongosh");
    expect(yaml).toContain("env_file:");
    expect(yaml).toContain(".env.docker");
  });

  it("wires the app service to MONGODB_URI and /health", () => {
    const yaml = composeTemplate({ dbPassword: "s3cret" });
    // The full URI lives in .env.docker (loaded via env_file); compose references it.
    expect(yaml).toContain("MONGODB_URI` from .env.docker");
    expect(yaml).toContain('IGNEX_HTTPS: "0"');
    expect(yaml).toContain("http://127.0.0.1:3000/health");
  });

  it("adds replica set machinery when --replica", () => {
    const yaml = composeTemplate({ dbPassword: "s3cret", replica: true });
    expect(yaml).toContain("--replSet");
    expect(yaml).toContain("mongodb-init");
    expect(yaml).toContain("rs.initiate");
    expect(yaml).toContain("replica set (rs0)");
  });

  it("omits replica set machinery when not enabled", () => {
    const yaml = composeTemplate({ dbPassword: "s3cret", replica: false });
    expect(yaml).not.toContain("--replSet");
    expect(yaml).not.toContain("mongodb-init");
    expect(yaml).not.toContain("replicaSet");
    expect(yaml).not.toContain("rs.initiate");
  });

  it("honors custom port, health path, and URI var", () => {
    const yaml = composeTemplate({
      dbPassword: "s3cret",
      port: 4444,
      healthPath: "/live",
      mongoUriVar: "DATABASE_URL",
    });
    expect(yaml).toContain('"4444:4444"');
    expect(yaml).toContain("http://127.0.0.1:4444/live");
    expect(yaml).toContain("DATABASE_URL` from .env.docker");
  });
});

describe("caddyfileTemplate", () => {
  it("reverse-proxies to the backend with HSTS at the terminator", () => {
    const caddy = caddyfileTemplate();
    expect(caddy).toContain("reverse_proxy 127.0.0.1:3000");
    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(caddy).toContain("example.com");
  });

  it("does not double-compress (the app's compression() plugin already does)", () => {
    const caddy = caddyfileTemplate();
    expect(caddy).not.toContain("encode gzip {");
  });

  it("honors custom domain and upstream", () => {
    const caddy = caddyfileTemplate({
      domains: ["api.example.com", "www.example.com"],
      upstream: "app:3000",
    });
    expect(caddy).toContain("api.example.com, www.example.com");
    expect(caddy).toContain("reverse_proxy app:3000");
  });
});

describe("dockerEnvTemplate", () => {
  it("writes credentials and a replica-aware URI", () => {
    const env = dockerEnvTemplate({ dbUser: "admin", dbPassword: "pw", replica: true });
    expect(env).toContain("MONGO_INITDB_ROOT_USERNAME=admin");
    expect(env).toContain("MONGO_INITDB_ROOT_PASSWORD=pw");
    expect(env).toContain("MONGODB_URI=mongodb://admin:pw@mongodb:27017/app?replicaSet=rs0");
  });

  it("drops the replica param when disabled", () => {
    const env = dockerEnvTemplate({ dbUser: "admin", dbPassword: "pw", replica: false });
    expect(env).toContain("MONGODB_URI=mongodb://admin:pw@mongodb:27017/app");
    expect(env).not.toContain("replicaSet");
  });
});

describe("dockerignoreTemplate", () => {
  it("excludes secrets and build artifacts by default", () => {
    const ignore = dockerignoreTemplate();
    expect(ignore).toContain("node_modules");
    expect(ignore).toContain("dist");
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".npmrc");
    expect(ignore).toContain(".env.docker");
  });

  it("keeps .env/.npmrc in context for private-registry builds", () => {
    const ignore = dockerignoreTemplate({ privateRegistry: true });
    expect(ignore).not.toContain("\n.env\n");
    expect(ignore).not.toContain("\n.npmrc\n");
    expect(ignore).toContain("Private-registry mode");
  });
});

describe("ignex ops (command wiring)", () => {
  it("generates a Dockerfile + .dockerignore", async () => {
    const dir = tmpTarget();
    try {
      await runOps(["dockerfile", "--root", dir, "--force"]);

      expect(existsSync(join(dir, "Dockerfile"))).toBe(true);
      expect(existsSync(join(dir, ".dockerignore"))).toBe(true);
      expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toContain(
        "FROM oven/bun:latest AS builder",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates compose + .env.docker with prompted credentials as flags", async () => {
    const dir = tmpTarget();
    try {
      await runOps([
        "compose",
        "--root",
        dir,
        "--force",
        "--db-user",
        "admin",
        "--db-password",
        "s3cret",
        "--replica",
      ]);

      expect(existsSync(join(dir, "docker-compose.yml"))).toBe(true);
      expect(existsSync(join(dir, ".env.docker"))).toBe(true);
      const env = readFileSync(join(dir, ".env.docker"), "utf8");
      expect(env).toContain("MONGO_INITDB_ROOT_USERNAME=admin");
      expect(env).toContain("MONGO_INITDB_ROOT_PASSWORD=s3cret");
      expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("--replSet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a Caddyfile via the --target flag", async () => {
    const dir = tmpTarget();
    try {
      await runOps(["--target", "caddy", "--root", dir, "--force", "--domain", "api.example.com"]);

      expect(existsSync(join(dir, "Caddyfile"))).toBe(true);
      expect(readFileSync(join(dir, "Caddyfile"), "utf8")).toContain("api.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates all files for the docker target", async () => {
    const dir = tmpTarget();
    try {
      await runOps([
        "docker",
        "--root",
        dir,
        "--force",
        "--db-user",
        "admin",
        "--db-password",
        "s3cret",
      ]);

      for (const file of [
        "Dockerfile",
        ".dockerignore",
        "docker-compose.yml",
        ".env.docker",
        "Caddyfile",
      ]) {
        expect(existsSync(join(dir, file))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports --yes to skip prompts non-interactively", async () => {
    const dir = tmpTarget();
    try {
      await runOps([
        "compose",
        "--root",
        dir,
        "--yes",
        "--db-user",
        "admin",
        "--db-password",
        "s3cret",
        "--no-replica",
      ]);

      const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
      expect(compose).not.toContain("--replSet");
      expect(existsSync(join(dir, ".env.docker"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a target non-interactively", async () => {
    const dir = tmpTarget();
    const originalExitCode = process.exitCode;
    try {
      await runOps(["--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown target", async () => {
    const dir = tmpTarget();
    const originalExitCode = process.exitCode;
    try {
      await runOps(["k8s", "--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite without --force", async () => {
    const dir = tmpTarget();
    const originalExitCode = process.exitCode;
    try {
      await runOps(["dockerfile", "--root", dir, "--force"]);
      expect(existsSync(join(dir, "Dockerfile"))).toBe(true);

      process.exitCode = 0;
      await runOps(["dockerfile", "--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a db password for compose non-interactively", async () => {
    const dir = tmpTarget();
    const originalExitCode = process.exitCode;
    try {
      await runOps(["compose", "--root", dir]);
      expect(process.exitCode).toBe(1);
      expect(existsSync(join(dir, "docker-compose.yml"))).toBe(false);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes ops targets as shell-completion values", () => {
    const ops = findCommand("ops");
    expect(ops).toBeDefined();
    const flags = parseFlagDocs(ops?.options);
    const target = flags.find((f) => f.flag === "--target");
    expect(target?.values).toEqual(["dockerfile", "compose", "caddy", "docker"]);
  });
});
