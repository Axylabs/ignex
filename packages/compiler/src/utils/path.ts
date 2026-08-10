/**
 * Project path resolution helpers.
 *
 * Compiler options like `appConfig` may be given as workspace-relative paths
 * (the common case) or absolute paths. `path.join(cwd, absolute)` silently
 * concatenates instead of resolving, so a shared helper is required.
 */

import { isAbsolute, join } from "node:path";

/** Resolve a possibly-relative project path against the current working dir. */
export const projectPath = (p: string): string => (isAbsolute(p) ? p : join(process.cwd(), p));
