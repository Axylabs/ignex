/**
 * @fileoverview Operational (resilience) journeys for the AOT-compiled server.
 *
 * The feature journeys in `user-journeys.test.ts` prove the happy paths; these
 * prove the server behaves like a production process when things go wrong —
 * which is exactly what a rolling deploy, a busy port, or a crashing handler
 * exercises:
 *
 *  - an in-flight request SURVIVES a `SIGTERM` drain (a rolling deploy must
 *    never drop a request mid-flight), and the process then exits 0;
 *  - a second signal forces an immediate non-zero exit so one wedged request
 *    can never hold a deploy hostage;
 *  - a boot failure (port already in use) is reported with an actionable,
 *    classified block and exits non-zero for the supervisor to restart;
 *  - a handler crash returns the generic envelope without leaking the message,
 *    and the process keeps serving under repeated failures;
 *  - a sequential client session reuses ONE keep-alive connection.
 *
 * Runs against the `ops` fixture — a production-shaped, non-WebSocket app whose
 * `/slow` route sleeps 400ms. Non-WS matters: a WS app must `stop(true)`, which
 * force-closes in-flight requests by design, so the graceful-drain window is
 * only observable without a socket route.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Agent, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer } from "./helpers/boot";

const OPS_FIXTURE = fileURLToPath(new URL("./fixtures/ops", import.meta.url));

/**
 * POSIX signals are only *deliverable as signals* on POSIX. On Windows
 * `process.kill(pid, "SIGTERM")` terminates the target outright — the handler
 * never runs — so the graceful-drain contract cannot be exercised there (the
 * same reason a Windows container must rely on the orchestrator's own grace
 * period). The signal-driven journeys are therefore POSIX-only; everything
 * else in this file is platform-independent.
 */
const SIGNALS_DELIVERABLE = process.platform !== "win32";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a child's exit code (null when it has not exited within the deadline). */
const waitForExit = async (proc: ChildProcess, timeoutMs = 15_000): Promise<number | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return proc.exitCode;
    // Exited via an unhandled signal — not the graceful path under test.
    if (proc.signalCode !== null) return null;
    await delay(25);
  }
  return null;
};

interface KeepAliveResult {
  status: number;
  body: string;
  localPort: number | undefined;
}

/** One GET over a keep-alive agent, reporting the client socket's local port. */
const httpGet = (port: number, path: string, agent: Agent): Promise<KeepAliveResult> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body, localPort: req.socket?.localPort }),
      );
    });
    req.on("error", reject);
    req.end();
  });

let srv: BootedServer;

beforeAll(async () => {
  // `rebuild: true` — these journeys assert on the CURRENT bootstrap (drain
  // ordering, boot-failure reporting), so the fixture must be compiled from the
  // compiler under test rather than a dist left over from an earlier run. The
  // harness serializes fixture rebuilds with a lockfile across workers.
  srv = await bootServer(OPS_FIXTURE, { protocol: "http", rebuild: true });
}, 60_000);

afterAll(() => srv?.close());

describe("operational journeys (compiled server)", () => {
  describe.runIf(SIGNALS_DELIVERABLE)("signal-driven drain (POSIX)", () => {
    it("drains an in-flight request on SIGTERM, then exits 0", async () => {
      const target = await bootServer(OPS_FIXTURE, { protocol: "http" });
      try {
        // `/slow` sleeps 400ms — start it, let it begin serving, then stop.
        const inflight = fetch(`${target.base}/slow`);
        await delay(80);
        target.proc.kill("SIGTERM");

        // The whole point: a rolling deploy must not drop this request.
        const res = await inflight;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ slow: true });

        // …and the process reports a CLEAN exit once the drain completes.
        expect(await waitForExit(target.proc)).toBe(0);
      } finally {
        target.proc.kill("SIGKILL");
      }
    });

    it("forces exit(1) on a second signal while draining", async () => {
      const target = await bootServer(OPS_FIXTURE, { protocol: "http" });
      try {
        // A request that is still running when the drain starts.
        const inflight = fetch(`${target.base}/slow`).catch(() => null);
        await delay(60);

        target.proc.kill("SIGTERM");
        await delay(30);
        // An operator (or an orchestrator) sending a second stop must not wait
        // out the deadline — one wedged request may not hold the deploy.
        target.proc.kill("SIGTERM");

        expect(await waitForExit(target.proc)).toBe(1);
        await inflight;
      } finally {
        target.proc.kill("SIGKILL");
      }
    });
  });

  it("reports an actionable failure and exits 1 when the port is already in use", async () => {
    const port = new URL(srv.base).port;
    const proc = spawn("bun", ["dist/__server.js"], {
      cwd: OPS_FIXTURE,
      env: { ...process.env, PORT: port, IGNEX_HTTPS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // A supervisor restarts on a non-zero exit; the log must say WHY.
    expect(await waitForExit(proc)).toBe(1);
    expect(stderr).toContain("ignex failed to start");
    expect(stderr).toMatch(/IGN_INTERNAL_PORT|already in use/i);
    // The raw throw must not masquerade as an unreadable stack dump.
    expect(stderr).not.toContain("uncaught exception");
  });

  it("returns the generic 500 envelope (no message leak) and keeps serving", async () => {
    const boom = await fetch(`${srv.base}/boom`);
    expect(boom.status).toBe(500);
    const body = (await boom.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
    });
    // The handler's own message must never reach the client.
    expect(JSON.stringify(body)).not.toContain("kaboom");

    // The failing route did not poison the process.
    expect((await fetch(`${srv.base}/health`)).status).toBe(200);
  });

  it("stays healthy under repeated handler failures", async () => {
    const failures = await Promise.all(Array.from({ length: 25 }, () => fetch(`${srv.base}/boom`)));
    expect(failures.every((res) => res.status === 500)).toBe(true);
    // Drain the bodies so sockets return to the pool.
    await Promise.all(failures.map((res) => res.arrayBuffer()));
    expect((await fetch(`${srv.base}/health`)).status).toBe(200);
  });

  it("reuses one keep-alive connection across a sequential session", async () => {
    const port = Number(new URL(srv.base).port);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const localPorts = new Set<number | undefined>();
      for (let i = 0; i < 5; i++) {
        const result = await httpGet(port, "/health", agent);
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ status: "ok" });
        localPorts.add(result.localPort);
      }
      // One client socket served the whole session (the keep-alive contract).
      expect(localPorts.size).toBe(1);
    } finally {
      agent.destroy();
    }
  });
});
