/**
 * @fileoverview Browser automation for `ignex dev --open`.
 *
 * `waitForServer` polls the spawned server until it answers (any HTTP status
 * counts — a 500 from a half-warmed route still means the port is live), then
 * `openBrowser` shells out to the platform opener. Both are best-effort: the
 * dev server never fails because the browser could not open.
 */

import { spawn } from "node:child_process";

/** How long `--open` waits for the server to answer before giving up (ms). */
export const OPEN_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for the server to answer (ms). */
const POLL_INTERVAL_MS = 250;

/**
 * Poll `url` until it responds or `timeoutMs` elapses.
 *
 * @returns true when the server answered within the budget.
 */
export async function waitForServer(
  url: string,
  timeoutMs = OPEN_TIMEOUT_MS,
  abort?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (abort?.aborted) return false;
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_500) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  return false;
}

/** Platform command that opens a URL in the default browser. */
function openerCommand(): { cmd: string; args: string[] } | undefined {
  switch (process.platform) {
    case "darwin":
      return { cmd: "open", args: [] };
    case "win32":
      return { cmd: "cmd", args: ["/c", "start", "", "/b"] };
    default:
      return { cmd: "xdg-open", args: [] };
  }
}

/**
 * Open `url` in the default browser (best-effort, fire-and-forget).
 *
 * @returns true when an opener process was launched successfully.
 */
export function openBrowser(url: string): boolean {
  // Bun exposes a native helper; prefer it when available.
  const bun = (globalThis as Record<string, unknown>).Bun as
    | { openInBrowser?(url: string): Promise<boolean> }
    | undefined;
  if (typeof bun?.openInBrowser === "function") {
    void bun.openInBrowser(url).catch(() => {});
    return true;
  }

  const opener = openerCommand();
  if (!opener) return false;
  try {
    const child = spawn(opener.cmd, [...opener.args, url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
