/**
 * @fileoverview CSRF plugin — double-submit cookie guard as a `FluxPlugin`.
 */

import { type FluxPlugin, hookToPlugin } from "../lifecycle/plugin";
import { type CsrfGuardOptions, createCsrfGuard } from "../security/csrf";

export const csrf = (options: CsrfGuardOptions): FluxPlugin =>
  hookToPlugin("csrf", createCsrfGuard(options));
