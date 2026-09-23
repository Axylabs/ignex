/**
 * Boot-failure reporting tests.
 *
 * A plugin that fails to boot used to surface as an uncaught error whose `cause`
 * was the raw driver error — Bun expands a `MongoServerError`'s enumerable BSON
 * graph into hundreds of lines of getter noise and zero guidance. These tests
 * pin the replacement contract: classify the throw, lead with the configuration
 * (`.env` state + the connection variable that was rejected, credentials
 * masked), and return a COMPACT error with no `cause`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explainBootFailure,
  renderBootFailure,
  reportPluginBootFailure,
} from "../src/platform/boot-failure.js";
import { EnvError, EnvIssueCodes } from "../src/platform/env-diagnostics.js";
import { readEnvFileReport } from "../src/platform/env-report.js";
import { maskCredentials } from "../src/platform/redact.js";

const dirs: string[] = [];

/** A temp cwd seeded with dotenv files. */
const makeDir = (files: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-boot-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `MongoServerError`-shaped throw (own enumerable props, like the driver's). */
const mongoAuthError = (): Error =>
  Object.assign(new Error("Command create requires authentication"), {
    name: "MongoServerError",
    code: 13,
    codeName: "Unauthorized",
  });

const DOTENV = [
  "NODE_ENV=development",
  "PORT=3000",
  "MONGO_URL=mongodb://root:s3cret@localhost:27017/app?replicaSet=rs0&authSource=admin",
  "",
].join("\n");

describe("maskCredentials", () => {
  it("masks the password and keeps the rest of the URL readable", () => {
    expect(maskCredentials("mongodb://root:s3cret@localhost:27017/app?authSource=admin")).toBe(
      "mongodb://root:***@localhost:27017/app?authSource=admin",
    );
    expect(maskCredentials("postgres://user@host:5432/db")).toBe("postgres://user@host:5432/db");
  });
});

describe("readEnvFileReport", () => {
  it("lists the dotenv files, examples and connection vars (values masked)", () => {
    const cwd = makeDir({
      ".env": DOTENV,
      ".env.example": "MONGO_URL=mongodb://localhost:27017/\n",
    });
    const report = readEnvFileReport(cwd);

    expect(report.present).toEqual([".env"]);
    expect(report.examples).toEqual([".env.example"]);
    expect(report.variables).toEqual([
      {
        key: "MONGO_URL",
        display: "mongodb://root:***@localhost:27017/app?replicaSet=rs0&authSource=admin",
        file: ".env",
      },
    ]);
    // A non-connection variable is never listed, so nothing else can leak.
    expect(JSON.stringify(report)).not.toContain("s3cret");
  });

  it("reports an absent .env without throwing", () => {
    const report = readEnvFileReport(makeDir());
    expect(report.present).toEqual([]);
    expect(report.variables).toEqual([]);
  });
});

describe("explainBootFailure", () => {
  it("classifies a rejected Mongo credential as a datastore failure", () => {
    const cwd = makeDir({ ".env": DOTENV });
    const thrown = new Error("[ignex] plugin boot failed for db: Command create requires…", {
      cause: mongoAuthError(),
    });

    const report = explainBootFailure("db", thrown, { cwd });

    expect(report.plugin).toBe("db");
    expect(report.fault.origin).toBe("db");
    expect(report.fault.kind).toBe("credentials");
    expect(report.fault.service).toBe("MongoDB");
    expect(report.fault.code).toBe("IGN_DB_CREDENTIALS");
    expect(report.fault.retryable).toBe(false);
    expect(report.fault.message).toBe("Command create requires authentication");
    expect(report.fault.causes).toEqual([
      { name: "MongoServerError", message: "Command create requires authentication", code: "13" },
    ]);
    expect(report.fault.hints.join("\n")).toContain("`MONGO_URL` in `.env`");
  });

  it("classifies an unreachable service and points at the host/port", () => {
    const cwd = makeDir({ ".env": DOTENV });
    const thrown = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:27017"), {
      name: "MongoNetworkError",
    });

    const report = explainBootFailure("db", thrown, { cwd });

    expect(report.fault.origin).toBe("db");
    expect(report.fault.kind).toBe("unreachable");
    expect(report.fault.retryable).toBe(true);
    expect(report.fault.summary).toBe("MongoDB is not reachable");
    expect(report.fault.hints.join("\n")).toContain("localhost` is the container itself");
  });

  it("classifies a taken port", () => {
    const thrown = Object.assign(new Error("Failed to listen at 0.0.0.0:3000"), {
      code: "EADDRINUSE",
    });

    const report = explainBootFailure("server", thrown, { cwd: makeDir() });

    expect(report.fault.kind).toBe("port");
    expect(report.fault.summary).toBe("Port 3000 is already in use");
  });

  it("surfaces the structured issues of an EnvError", () => {
    const thrown = new EnvError([
      {
        code: EnvIssueCodes.MissingRequired,
        severity: "error",
        key: "MONGO_URL",
        message: "Missing required variable",
      },
    ]);

    const report = explainBootFailure("config", thrown, { cwd: makeDir() });
    const rendered = renderBootFailure(report);

    expect(report.fault.origin).toBe("config");
    expect(report.fault.kind).toBe("invalid");
    expect(report.fault.issues).toHaveLength(1);
    expect(rendered).toContain("MONGO_URL");
    expect(rendered).toContain("Missing required variable");
  });

  it("falls back to an unclassified internal fault with an escape hatch", () => {
    const report = explainBootFailure("db", new TypeError("x is not a function"), {
      cwd: makeDir(),
    });
    expect(report.fault.origin).toBe("internal");
    expect(report.fault.kind).toBe("unexpected");
    expect(report.fault.summary).toBe("Unhandled TypeError");
    expect(report.fault.hints.join("\n")).toContain("IGNEX_DEBUG=1");
  });
});

describe("renderBootFailure", () => {
  it("leads with the configuration check and never prints the password", () => {
    const cwd = makeDir({ ".env": DOTENV, ".env.example": "MONGO_URL=\n" });
    const rendered = renderBootFailure(explainBootFailure("db", mongoAuthError(), { cwd }));

    expect(rendered).toContain('✖ ignex boot failed — plugin "db" could not start');
    expect(rendered).toContain("code     IGN_DB_CREDENTIALS · db · MongoDB");
    expect(rendered).toContain("what     MongoDB rejected the credentials");
    expect(rendered).toContain("message  Command create requires authentication");
    expect(rendered).toContain("Configuration check (do this first)");
    expect(rendered).toContain("MONGO_URL");
    expect(rendered).not.toContain("s3cret");
    // Config section comes before the advice section.
    expect(rendered.indexOf("Configuration check")).toBeLessThan(rendered.indexOf("What to fix"));
  });

  it("offers the example file when .env is missing", () => {
    const cwd = makeDir({ ".env.example": "MONGO_URL=\n" });
    const rendered = renderBootFailure(explainBootFailure("db", mongoAuthError(), { cwd }));

    expect(rendered).toContain("NOT FOUND");
    expect(rendered).toContain("cp .env.example .env");
  });
});

describe("reportPluginBootFailure", () => {
  it("prints one report and returns a compact, cause-free error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = mongoAuthError();

    const failure = reportPluginBootFailure("db", raw);
    const calls = spy.mock.calls.map((call) => String(call[0]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0]).toContain('✖ ignex boot failed — plugin "db"');
    expect(failure.message).toBe(
      "[ignex] plugin boot failed for db: Command create requires authentication",
    );
    // The raw driver object must NOT ride along as `cause` — that is exactly
    // what Bun expanded into hundreds of lines.
    expect(failure.cause).toBeUndefined();
  });

  it("is idempotent — reporting the same failure twice prints once", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const failure = reportPluginBootFailure("db", mongoAuthError());
    reportPluginBootFailure("db", failure);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for an AggregateError whose children were all reported", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = reportPluginBootFailure("db", mongoAuthError());
    const second = reportPluginBootFailure("cache", new Error("boom"));
    spy.mockClear();

    const aggregate = reportPluginBootFailure(
      "app",
      new AggregateError([first, second], "2 failed"),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(aggregate.message).toContain("see the reports above");
  });
});
