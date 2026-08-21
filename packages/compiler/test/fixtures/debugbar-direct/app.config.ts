// Direct-element debugbar fixture: `plugins: [debugbar()]` (no env gate) — the
// shape the docs recommend. Used by the cache-poisoning regression test.
import { debugbar } from "@ignex/core";

export const plugins = [debugbar()];

export const server = {
  port: 3000,
  https: false,
};
