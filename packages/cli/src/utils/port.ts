/**
 * @fileoverview Best-effort port inspection for `ignex dev`: find which
 * process is listening on a port and kill it. Powers the EADDRINUSE UX
 * ("Port 3000 is in use by <proc> — kill it?") and the `--kill-port` flag.
 *
 * Uses whatever the platform provides (lsof/fuser on macOS+Linux, netstat +
 * tasklist on Windows) and degrades to `null`/`false` instead of throwing, so
 * dev keeps working on machines without those tools.
 */

import { spawnSync } from "node:child_process";

/** A process occupying a TCP port. */
export interface PortOwner {
  pid: number;
  /** Human-readable command name, best-effort ("node", "bun", ...). */
  command: string;
}

/** Run a command, return stdout trimmed (empty string on any failure). */
function run(...args: string[]): string {
  const bin = args[0] ?? "";
  if (!bin) return "";
  try {
    const result = spawnSync(bin, args.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

/** Resolve a pid to a command name via ps (POSIX). */
function commandName(pid: number): string {
  return run("ps", "-p", String(pid), "-o", "comm=").split("\n")[0]?.trim() ?? "";
}

/** Find the owner of `port` on macOS/Linux via lsof (fallback: fuser). */
function findPosixOwner(port: number): PortOwner | null {
  // lsof: one pid per line, LISTEN sockets only.
  const pids = run("lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (pids.length === 0) {
    // fuser prints "<port>/tcp:" followed by pids — take the last token.
    const out = run("fuser", `${port}/tcp`).split(/\s+/).filter(Boolean);
    const pid = Number(out.at(-1));
    if (Number.isFinite(pid) && pid > 0) {
      return { pid, command: commandName(pid) };
    }
    return null;
  }

  const pid = pids[0];
  if (pid === undefined) return null;
  return { pid, command: commandName(pid) };
}

/** Find the owner of `port` on Windows via netstat + tasklist. */
function findWindowsOwner(port: number): PortOwner | null {
  const lines = run("netstat", "-ano").split("\n");
  const needle = `:${port}`;
  for (const line of lines) {
    // "  TCP    0.0.0.0:3000   0.0.0.0:0    LISTENING    1234"
    const parts = line.trim().split(/\s+/);
    const [proto, local, , state, pidRaw] = parts;
    if (proto !== "TCP" || !local?.endsWith(needle)) continue;
    if (state !== "LISTENING") continue;
    const pid = Number(pidRaw);
    if (!Number.isFinite(pid) || pid === 0) continue;
    const task = run("tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH");
    const name = task.split(",")[0]?.replace(/"/g, "") ?? "";
    return { pid, command: name };
  }
  return null;
}

/**
 * Find the process listening on `port`, or `null` when the port is free (or
 * the platform tooling is unavailable).
 */
export function findPortOwner(port: number): PortOwner | null {
  try {
    return process.platform === "win32" ? findWindowsOwner(port) : findPosixOwner(port);
  } catch {
    return null;
  }
}

/**
 * Kill the process occupying a port. Returns `true` when the signal was sent
 * (or the process is already gone); `false` when the OS refused (e.g. no
 * permission).
 */
export function killPortOwner(owner: PortOwner): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(owner.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(owner.pid, "SIGTERM");
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ESRCH") {
      return true; // already gone
    }
    return false;
  }
}
