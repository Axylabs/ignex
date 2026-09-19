import { describe, expect, it } from "vitest";
import { formatKnowledgeMarkdown } from "../src/debug/kt";
import type { AppKnowledge } from "../src/debug/types";

const emptyKnowledge: AppKnowledge = {
  serviceName: "Example",
  version: "1.0.0",
  debugMode: true,
  environment: {},
  runtime: {
    bunVersion: "1.4.0",
    platform: "linux",
    arch: "x64",
    pid: 42,
    nodeEnv: "test",
    startedAt: 0,
    uptimeSec: 0,
  },
  routes: [],
  plugins: [],
  lifecycle: [],
  spanKinds: [],
  sdk: null,
  areas: [],
  docs: [],
  dbActions: [],
  notes: [],
};

const populatedKnowledge: AppKnowledge = {
  ...emptyKnowledge,
  environment: { NODE_ENV: "test" },
  areas: [
    {
      name: "Routes",
      dir: "src/routes",
      description: "Request handlers.",
      fileCount: 1,
      files: ["health.get.ts"],
    },
    {
      name: "Configuration",
      dir: "app.config.ts",
      description: "Application configuration.",
      fileCount: 1,
      files: [],
    },
  ],
  plugins: [{ name: "logger", description: "Request logging." }],
  lifecycle: [
    { name: "afterHandle", hookCount: 2, order: 1 },
    { name: "request", hookCount: 1, order: 0 },
  ],
  routes: [
    {
      method: "GET",
      path: "/health",
      file: "src/routes/health.get.ts",
      description: "Health check",
      usage: ["query", "headers"],
      isConstant: false,
      hooks: [],
    },
    {
      method: "POST",
      path: "/refresh",
      file: null,
      description: "Refresh state",
      usage: [],
      isConstant: false,
      hooks: [],
    },
  ],
  dbActions: [
    {
      action: "SELECT",
      table: "users",
      statement: "SELECT * FROM users WHERE id = ?",
      calls: 2,
      totalMs: 3.5,
      routes: ["GET /users/:id"],
    },
    { action: "SELECT", table: null, statement: "SELECT ?", calls: 1, totalMs: 1, routes: [] },
  ],
  spanKinds: ["request", "lifecycle", "db", "cache", "http", "render", "auth", "custom", "error"],
  sdk: {
    name: "@example/sdk",
    version: "1.0.0",
    location: "sdk",
    files: ["index.ts", "types.ts"],
    gitTags: ["sdk-v1.0.0"],
    published: "tagged",
  },
  docs: [{ path: "docs/start.md", title: "Getting started" }],
  notes: ["Example deployment."],
};

describe("formatKnowledgeMarkdown", () => {
  it.each([
    ["empty", emptyKnowledge],
    ["populated", populatedKnowledge],
  ] as const)("preserves the %s snapshot's Markdown without mutating its input", (_, knowledge) => {
    const before = structuredClone(knowledge);
    expect(formatKnowledgeMarkdown(knowledge)).toMatchSnapshot();
    expect(knowledge).toEqual(before);
  });
});
