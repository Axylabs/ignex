/**
 * @fileoverview Session plugin — attaches the current session to every request.
 */

import type { FluxPlugin } from "../plugin";
import { createSessionManager, type SessionManagerOptions } from "../session";

export interface SessionPluginOptions extends SessionManagerOptions {
  createIfMissing?: boolean;
}

export const session = (options: SessionPluginOptions): FluxPlugin => {
  const manager = createSessionManager(options);
  const hook = manager.middleware({ createIfMissing: options.createIfMissing ?? false });

  return {
    name: "session",
    async onRequest(ctx) {
      const result = await hook(ctx);
      return result.ok ? result.ctx : result.response;
    },
  };
};
