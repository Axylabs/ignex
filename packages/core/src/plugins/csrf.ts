/**
 * @fileoverview CSRF plugin — double-submit cookie guard as a `IgnexPlugin`.
 */

import { hookToPlugin, type IgnexPlugin } from "../lifecycle/plugin";
import { type CsrfGuardOptions, createCsrfGuard } from "../security/csrf";

/**
 * CSRF protection plugin (double-submit signed cookie guard).
 *
 * @param options - Secret + cookie/header naming and method coverage.
 * @returns The CSRF plugin.
 */
export const csrf = (options: CsrfGuardOptions): IgnexPlugin =>
  hookToPlugin("csrf", createCsrfGuard(options));
