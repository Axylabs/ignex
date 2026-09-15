/**
 * AOT fixture: an app whose ONLY lifecycle is the declarable plugin layer.
 *
 * `cors()` and `security()` are framework plugins whose context requirements are
 * declared (`INTERNAL_PLUGIN_USAGE`), and the specialized context emits every
 * member they read — so this app's routes must stay on the usage-specialized
 * tier while the plugins' hooks still run there. Before the ladder existed, any
 * active plugin set `hasGlobalLifecycle` and dragged every route onto the full
 * context.
 */
import { cors, type IgnexPlugin, security } from "@ignex/core";

export const plugins: IgnexPlugin[] = [
  cors({ origin: ["https://example.com"] }),
  security({ contentSecurityPolicy: "default-src 'self'" }),
];
