/**
 * Process-level crash backstop tests — `installProcessGuards` registers the
 * two handlers exactly once (idempotent) so a stray unhandled rejection from a
 * user hook can't terminate the server process.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

afterAll(() => {
  // This test file is isolated in its own worker; don't leave the real guards
  // installed for the rest of the file's lifetime.
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
});

describe("installProcessGuards", () => {
  it("registers unhandledRejection + uncaughtException handlers exactly once", async () => {
    vi.resetModules();
    const on = vi.spyOn(process, "on");
    const { installProcessGuards } = await import("../src/platform/process-guards.js");
    installProcessGuards();
    installProcessGuards(); // must be a no-op (module-level `installed` flag)

    const events = on.mock.calls.map(([event]) => event as string);
    expect(events.filter((e) => e === "unhandledRejection")).toHaveLength(1);
    expect(events.filter((e) => e === "uncaughtException")).toHaveLength(1);

    on.mockRestore();
  });
});
