/**
 * @fileoverview Session plugin — attaches the current session to every request.
 */

import { type FluxPlugin, hookToPlugin } from "../lifecycle/plugin";
import { createSessionManager, type SessionManagerOptions } from "../security/session";

export interface SessionPluginOptions extends SessionManagerOptions {
  createIfMissing?: boolean;
}

export const session = (options: SessionPluginOptions): FluxPlugin => {
  const manager = createSessionManager(options);
  const hook = manager.middleware({ createIfMissing: options.createIfMissing ?? false });

  return hookToPlugin("session", hook, () => manager.close?.());
};
