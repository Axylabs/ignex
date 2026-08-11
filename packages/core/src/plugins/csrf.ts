/**
 * @fileoverview CSRF plugin — double-submit cookie guard as a `IgnusPlugin`.
 */

import { hookToPlugin, type IgnusPlugin } from "../lifecycle/plugin";
import { type CsrfGuardOptions, createCsrfGuard } from "../security/csrf";

export const csrf = (options: CsrfGuardOptions): IgnusPlugin =>
  hookToPlugin("csrf", createCsrfGuard(options));
