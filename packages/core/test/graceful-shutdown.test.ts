/**
 * Graceful shutdown on process signals — the interpreted `serve()` counterpart
 * of the AOT server's inline drain. The exit hook is injected so a test can
 * assert the contract without exiting the vitest worker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/lifecycle/app-factory";
import { installGracefulShutdown } from "../src/platform/graceful-shutdown";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApp().serve() wiring", () => {
  it("installs the drain on bind and a manual stop() disposes it", async () => {
    const before = process.listenerCount("SIGTERM");
    vi.stubGlobal("Bun", {
      serve: vi.fn(() => ({ stop: vi.fn() })),
      which: vi.fn(() => null),
      spawnSync: vi.fn(() => ({ exitCode: 0, stderr: "" })),
    });

    const app = createApp({ handler: () => new Response("ok") });
    app.serve({ https: false, port: 0 });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    await app.stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("keeps the drain listeners installed when disposeSignals is false, so a second signal reaches the helper", async () => {
    const before = process.listenerCount("SIGTERM");
    vi.stubGlobal("Bun", {
      serve: vi.fn(() => ({ stop: vi.fn() })),
      which: vi.fn(() => null),
      spawnSync: vi.fn(() => ({ exitCode: 0, stderr: "" })),
    });

    const app = createApp({ handler: () => new Response("ok") });
    app.serve({ https: false, port: 0 });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    // The drain runs with `disposeSignals: false`: disposing here would turn a
    // SECOND signal into the runtime's default kill instead of the helper's
    // log + exit(1) — the AOT bootstrap and createApp().serve() must agree.
    await app.stop({ disposeSignals: false });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    // A later manual stop still cleans up (never leak handlers).
    await app.stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("installGracefulShutdown", () => {
  it("drains once on the first signal and exits 0", async () => {
    const exits: number[] = [];
    const signals: string[] = [];
    const logs: string[] = [];
    const dispose = installGracefulShutdown(
      (signal) => {
        signals.push(signal);
      },
      { exit: (code) => exits.push(code), log: (m) => logs.push(m), logError: () => {} },
    );

    process.emit("SIGTERM");
    await tick();

    expect(signals).toEqual(["SIGTERM"]);
    expect(exits).toEqual([0]);
    expect(logs.some((line) => line.includes("received SIGTERM"))).toBe(true);
    dispose();
  });

  it("exits 1 immediately on a second signal, without draining twice", async () => {
    const exits: number[] = [];
    let drains = 0;
    const dispose = installGracefulShutdown(
      () => {
        drains += 1;
      },
      { exit: (code) => exits.push(code), log: () => {}, logError: () => {} },
    );

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    await tick();

    expect(drains).toBe(1);
    expect(exits).toEqual([1]);
    dispose();
  });

  it("exits 1 when the drain exceeds the deadline", async () => {
    const exits: number[] = [];
    const dispose = installGracefulShutdown(() => new Promise<void>(() => {}), {
      deadlineMs: 1,
      exit: (code) => exits.push(code),
      log: () => {},
      logError: () => {},
    });

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exits).toEqual([1]);
    dispose();
  });

  it("exits 1 when the drain rejects", async () => {
    const exits: number[] = [];
    const errors: string[] = [];
    const dispose = installGracefulShutdown(
      () => {
        throw new Error("store close failed");
      },
      {
        exit: (code) => exits.push(code),
        log: () => {},
        logError: (m) => errors.push(m),
      },
    );

    process.emit("SIGTERM");
    await tick();

    expect(exits).toEqual([1]);
    expect(errors.some((line) => line.includes("store close failed"))).toBe(true);
    dispose();
  });

  it("removes every listener it installed (no leak onto the shared process)", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const dispose = installGracefulShutdown(() => {}, { log: () => {}, logError: () => {} });

    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);

    dispose();
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });
});
