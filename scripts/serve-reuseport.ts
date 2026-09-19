#!/usr/bin/env bun
/**
 * @fileoverview Run N processes of one built artifact on a SINGLE port.
 *
 * `reusePort` maps to `SO_REUSEPORT`: N processes bind the same port and the
 * kernel spreads accepted connections across them — no external load balancer
 * and no `cluster` module. It is the measured multi-process scaling lever
 * (~+66–78% RPS and roughly half the p50 at 2 processes; see
 * `docs/deployment.md` §3). A single process gains nothing.
 *
 * Usage:
 *   bun scripts/serve-reuseport.ts [entry] [processes] [cwd]
 *   bun run serve:reuseport -- packages/app/dist/__server.js 2 packages/app
 *
 * Defaults: entry `packages/app/dist/__server.js`, 2 processes, cwd
 * `process.cwd()`, `PORT=3000`. The reference app resolves its views relative
 * to its package dir, so pass `packages/app` as the third argument (or set
 * `IGNEX_SERVE_CWD`). Every child inherits the parent env with
 * `IGNEX_REUSE_PORT=1` forced on, so any app env (PORT, TLS, …) is forwarded
 * unchanged. SIGINT/SIGTERM is forwarded to every child, and the supervisor
 * exits with the first non-zero child code once all children have stopped.
 *
 * @remarks Per-process state (rate limiter, session store, HTTP cache) is NOT
 * shared — externalize it before scaling out. Keep the process count at a small
 * multiple of the core count; beyond that the kernel's spreading plus per-
 * process state becomes host-dependent.
 */
import { cpus } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--");
const entry = resolve(args[0] ?? "packages/app/dist/__server.js");
const requested = Number(args[1] ?? process.env.IGNEX_REPLICAS ?? 2);
const count = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 2;
const cwdArg = args[2] ?? process.env.IGNEX_SERVE_CWD;
const cwd = cwdArg ? resolve(cwdArg) : process.cwd();
const port = process.env.PORT ?? "3000";

const cores = cpus().length;
if (count > cores) {
  console.warn(
    `[reuseport] ${count} processes on ${cores} cores — beyond a small multiple ` +
      "the kernel spread plus per-process state is host-dependent (see docs/deployment.md).",
  );
}

if (!(await Bun.file(entry).exists())) {
  console.error(`[reuseport] entry not found: ${entry} (build it first: bun run build)`);
  process.exit(1);
}

console.log(`[reuseport] ${count} × ${entry} on port ${port} (SO_REUSEPORT)`);

const children = Array.from({ length: count }, () =>
  Bun.spawn([process.execPath, entry], {
    cwd,
    env: { ...process.env, PORT: port, IGNEX_REUSE_PORT: "1" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }),
);

let stopping = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
  }
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const codes = await Promise.all(children.map((child) => child.exited));
process.exit(codes.some((code) => code !== 0) ? 1 : 0);
