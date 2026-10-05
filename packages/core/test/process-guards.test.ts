/**
 * Process-level crash backstop tests — `installProcessGuards` registers the
 * two handlers exactly once (idempotent) so a stray unhandled rejection from a
 * user hook can't terminate the server process, and both funnel through the
 * classified fault pipeline (a redacted, deduped block) instead of dumping an
 * arbitrary rejected value.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

afterAll(() => {
  // This test file is isolated in its own worker; don't leave the real guards
  // installed for the rest of the file's lifetime.
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
});

type Handler = (arg: unknown) => void;

/**
 * Import a FRESH guards module and capture the handlers it registers without
 * installing them on the real process (the `process.on` spy does not call
 * through), so exercising them cannot leak listeners or kill the worker.
 */
const captureHandlers = async (): Promise<Map<string, Handler>> => {
  vi.resetModules();
  const handlers = new Map<string, Handler>();
  const on = vi
    .spyOn(process, "on")
    .mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler as Handler);
      return process;
    });
  const { installProcessGuards } = await import("../src/platform/process-guards.js");
  installProcessGuards();
  on.mockRestore();
  return handlers;
};

/** Run a payload through a handler with `console.error` captured. */
const run = (
  handlers: Map<string, Handler>,
  event: string,
  payload: unknown,
): { printed: string } => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    handlers.get(event)?.(payload);
    return { printed: err.mock.calls.map((call) => String(call[0])).join("\n") };
  } finally {
    err.mockRestore();
  }
};

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

  it("reports an unhandled rejection through the classified fault pipeline (and does not exit)", async () => {
    const handlers = await captureHandlers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { printed } = run(handlers, "unhandledRejection", new Error("hook blew up"));

    // The report carries the actionable title, not a bare "rejection:" dump.
    expect(printed).toContain("unhandled promise rejection");
    expect(printed).toContain("hook blew up");
    // Recoverable: a stray rejection must never terminate the server.
    expect(exit).not.toHaveBeenCalled();

    exit.mockRestore();
  });

  it("survives a cyclic / primitive rejection without throwing", async () => {
    const handlers = await captureHandlers();
    const cyclic: Record<string, unknown> = { message: "cyclic" };
    cyclic.self = cyclic;

    for (const payload of [cyclic, "just a string", null, undefined, 42]) {
      expect(() => run(handlers, "unhandledRejection", payload)).not.toThrow();
    }
  });

  it("reports and exits(1) on an uncaught exception", async () => {
    const handlers = await captureHandlers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { printed } = run(handlers, "uncaughtException", new Error("sync boom"));

    expect(printed).toContain("uncaught exception");
    expect(printed).toContain("sync boom");
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
  });
});
