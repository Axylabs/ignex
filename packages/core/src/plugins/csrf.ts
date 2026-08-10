/**
 * @fileoverview CSRF plugin — double-submit cookie guard as a `FluxPlugin`.
 */
import { type CsrfGuardOptions, createCsrfGuard } from "../csrf";
import type { FluxPlugin } from "../plugin";

export const csrf = (options: CsrfGuardOptions): FluxPlugin => {
  const hook = createCsrfGuard(options);

  return {
    name: "csrf",
    async onRequest(ctx) {
      const result = await hook(ctx);
      return result.ok ? result.ctx : result.response;
    },
  };
};
