// Dev-only plugin elimination fixture: a constant route + a default-mode
// `debugbar()` plugin. Production builds must eliminate the debugbar and hoist
// the constant; dev builds keep the debugbar and its full-context pipeline.
import { debugbar } from "@ignex/core";

export const plugins = [debugbar()];

export const server = {
  port: 3000,
  https: false,
};
