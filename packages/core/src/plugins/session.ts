/**
 * @fileoverview Session plugin — attaches the current session to every request.
 */

import { hookToPlugin, type IgnusPlugin } from "../lifecycle/plugin";
import { createSessionManager, type SessionManagerOptions } from "../security/session";

export interface SessionPluginOptions extends SessionManagerOptions {
  /**
   * When to create a session when the request has none:
   * - `true` — eager: create + sign + `Set-Cookie` on every request (classic).
   * - `"lazy"` — create only when a handler first reads it via `getSession()`
   *   (zero session work for requests that never use a session; recommended).
   * - `false` (default) — never create; load existing sessions only.
   */
  createIfMissing?: boolean | "lazy";
}

export const session = (options: SessionPluginOptions): IgnusPlugin => {
  const manager = createSessionManager(options);
  const hook = manager.middleware({ createIfMissing: options.createIfMissing ?? false });

  return hookToPlugin("session", hook, () => manager.close?.());
};
