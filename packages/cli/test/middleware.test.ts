/**
 * @fileoverview Middleware scaffold uses core plugins without demo plumbing.
 */

import { expect, test } from "vitest";
import { parseFeatures } from "../src/commands/create.js";
import { middlewareIndexTemplate, middlewareReadmeTemplate } from "../src/templates/middleware.js";
import { appConfigTemplate } from "../src/templates/routes.js";
import { FEATURE_NAMES } from "../src/types.js";

test("FEATURE_NAMES includes middleware", () => {
  expect(FEATURE_NAMES).toContain("middleware");
});

test("parseFeatures resolves middleware aliases", () => {
  expect(parseFeatures("middleware")).toEqual(new Set(["middleware"]));
  expect(parseFeatures("global-hooks")).toEqual(new Set(["middleware"]));
});

test("appConfigTemplate without middleware has no lifecycle", () => {
  const code = appConfigTemplate();
  expect(code).not.toContain("middleware");
  expect(code).not.toContain("lifecycle");
  expect(code).not.toContain("logRequests");
});

test("appConfigTemplate with middleware wires only the plugin array", () => {
  const code = appConfigTemplate({ middleware: true });
  expect(code).toContain('import { middleware } from "./middleware/index.js";');
  expect(code).toContain("...middleware,");
  expect(code).not.toContain("export const lifecycle");
  expect(code).not.toContain("logRequests");
  expect(code).not.toContain("markResponse");
});

test("middlewareIndexTemplate uses the built-in request-id plugin", () => {
  const code = middlewareIndexTemplate();
  expect(code).toContain('import { requestId } from "@ignex/core";');
  expect(code).toContain("export const middleware = [");
  expect(code).toContain("requestId()");
  expect(code).not.toContain("crypto.randomUUID");
  expect(code).not.toContain("mutateHeaders");
});

test("middlewareReadmeTemplate documents extension points without demo files", () => {
  const code = middlewareReadmeTemplate();
  expect(code).toContain("IgnexPlugin");
  expect(code).toContain("lifecycle");
  expect(code).toContain("ignex hook <name>");
  expect(code).not.toContain("log-requests.ts");
});
