/**
 * Generator tests for the `middleware` (global hooks) scaffold feature.
 *
 * Covers the `src/middleware/` templates (custom `IgnexPlugin` + lifecycle
 * `HookFn`s) and the feature-aware `app.config.ts` wiring (`plugins` spread +
 * `lifecycle` export), plus feature parsing for `middleware`.
 */
import { expect, test } from "vitest";
import { parseFeatures } from "../src/commands/create.js";
import {
  middlewareIndexTemplate,
  middlewareLogRequestsTemplate,
  middlewareReadmeTemplate,
  middlewareRequestIdTemplate,
} from "../src/templates/middleware.js";
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

test("appConfigTemplate with middleware wires plugins + lifecycle", () => {
  const code = appConfigTemplate({ middleware: true });
  expect(code).toContain('import { middleware } from "./middleware/index.js";');
  expect(code).toContain(
    'import { logRequests, markResponse } from "./middleware/log-requests.js";',
  );
  expect(code).toContain("...middleware,");
  expect(code).toContain("export const lifecycle = {");
  expect(code).toContain("beforeHandle: [logRequests(), markResponse()]");
});

test("middlewareRequestIdTemplate emits a custom IgnexPlugin", () => {
  const code = middlewareRequestIdTemplate();
  expect(code).toContain('import { mutateHeaders, type IgnexPlugin } from "@ignex/core";');
  expect(code).toContain("onRequest(ctx)");
  expect(code).toContain("onResponse(ctx, response)");
  expect(code).toContain('headers.set("x-request-id", id)');
});

test("middlewareLogRequestsTemplate emits beforeHandle hooks via ctx.set", () => {
  const code = middlewareLogRequestsTemplate();
  expect(code).toContain("export const logRequests = (): HookFn =>");
  expect(code).toContain("export const markResponse = (): HookFn =>");
  expect(code).toContain("continueHook(ctx)");
  expect(code).toContain('ctx.set.headers["x-ignex-middleware"] = "true";');
});

test("middlewareIndexTemplate exports the middleware array", () => {
  const code = middlewareIndexTemplate();
  expect(code).toContain("export const middleware = [");
  expect(code).toContain("requestId()");
});

test("middlewareReadmeTemplate documents global vs per-route hooks", () => {
  const code = middlewareReadmeTemplate();
  expect(code).toContain("IgnexPlugin");
  expect(code).toContain("beforeHandle");
  expect(code).toContain("ignex hook <name>");
});
