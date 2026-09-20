/**
 * @fileoverview Ignex Lifecycle Orchestrator
 *
 * This module orchestrates the lifecycle stages and delegates to focused
 * sub-modules for specific concerns:
 *
 *   - App factory and composition  → app-factory.ts
 *   - Plugin integration           → plugin.ts
 *   - Lifecycle stage management   → run.ts
 *   - Serve/stop integration       → serve.ts
 *
 * The public API is maintained through re-exports so consumers see no
 * change in the imported surface.
 */

// Re-export from sub-modules to maintain backward compatibility
export {
  buildPostStages,
  buildPreStages,
  debugStageEnd,
  lifecycleTracing,
  POST_HANDLER_STAGES,
  PRE_HANDLER_STAGES,
  PRE_PARSE_STAGES,
  runHooks,
  runLifecycle,
  runTimed,
} from "./run";

// Import app factory types and functions for re-export
import type { AppOptions, IgnexApp, ServeOptions } from "./app-factory";
import { createApp } from "./app-factory";

// Response/transport defaults that were public before the split
export {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  DEFAULT_WS_MAX_PAYLOAD_LENGTH,
} from "./app-factory";
// Re-export app factory types and functions
export type { AppOptions, IgnexApp, ServeOptions };
export { createApp };
