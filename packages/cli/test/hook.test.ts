/**
 * Tests for `ignex hook <name>` — the named/global hook scaffolder.
 *
 * Covers the hook file templates (named default-export vs global named-export)
 * and the pure `addGlobalHookToConfig` transform that registers a global hook
 * on `app.config.ts`'s `lifecycle` (create, add stage, append to array, dedup).
 */
import { expect, test } from "vitest";
import { addGlobalHookToConfig, GLOBAL_STAGES } from "../src/commands/hook.js";
import { globalHookTemplate, namedHookTemplate } from "../src/templates/hook.js";

test("namedHookTemplate emits a default-export hook", () => {
  const code = namedHookTemplate("requireAdmin");
  expect(code).toContain('import { continueHook, type HookFn } from "@ignex/core";');
  expect(code).toContain("export default ((ctx) => {");
  expect(code).toContain('export const config = { hooks: ["requireAdmin"] };');
});

test("globalHookTemplate emits a named-export hook", () => {
  const code = globalHookTemplate("tenantResolver");
  expect(code).toContain("export const tenantResolver = ((ctx) => {");
  expect(code).toContain("lifecycle = { beforeHandle: [tenantResolver] }");
});

test("GLOBAL_STAGES lists the lifecycle stages", () => {
  expect(GLOBAL_STAGES).toContain("beforeHandle");
  expect(GLOBAL_STAGES).toContain("afterHandle");
  expect(GLOBAL_STAGES).toContain("mapResponse");
  expect(GLOBAL_STAGES).toContain("error");
});

test("addGlobalHookToConfig appends a lifecycle export when none exists", () => {
  const source = "export const server = { port: 3000 };\n";
  const { content, added } = addGlobalHookToConfig(source, "logRequests", "beforeHandle");
  expect(added).toBe(true);
  expect(content).toContain('import { logRequests } from "./hooks/logRequests.js";');
  expect(content).toContain("export const lifecycle = {");
  expect(content).toContain("beforeHandle: [logRequests]");
});

test("addGlobalHookToConfig adds the import at the top when none exist", () => {
  const source = "export const server = { port: 3000 };\n";
  const { content } = addGlobalHookToConfig(source, "x", "beforeHandle");
  expect(content.startsWith('import { x } from "./hooks/x.js";')).toBe(true);
});

test("addGlobalHookToConfig inserts a missing stage into an existing lifecycle", () => {
  const source = `export const lifecycle = {
  beforeHandle: [a()]
};
`;
  const { content, added } = addGlobalHookToConfig(source, "b", "afterHandle");
  expect(added).toBe(true);
  expect(content).toContain("afterHandle: [b],");
  expect(content).toContain("beforeHandle: [a()]");
});

test("addGlobalHookToConfig appends to an existing stage array", () => {
  const source = `export const lifecycle = {
  beforeHandle: [a()]
};
`;
  const { content, added } = addGlobalHookToConfig(source, "b", "beforeHandle");
  expect(added).toBe(true);
  expect(content).toContain("beforeHandle: [a(), b]");
});

test("addGlobalHookToConfig does not duplicate an existing hook", () => {
  const source = `import { a } from "./hooks/a.js";
import { b } from "./hooks/b.js";

export const lifecycle = {
  beforeHandle: [a(), b]
};
`;
  const { content, added } = addGlobalHookToConfig(source, "b", "beforeHandle");
  expect(added).toBe(false);
  expect(content).toBe(source);
});
