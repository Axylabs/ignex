/**
 * @fileoverview Standalone-executable output path resolution.
 *
 * The rule lives here — not in the linker — because `ignex build` prints the
 * same path in its status line. A private copy on the CLI side silently drifted
 * from the linker's rule; this is the single definition both read.
 */

import { isAbsolute, join } from "node:path";

/** The `CompilerOptions` fields the rule reads (structural, so any opts work). */
export interface BinaryOutPathOptions {
  readonly outDir: string;
  readonly serviceName?: string;
  readonly binaryOutfile?: string;
}

/**
 * Resolve the output path for a standalone executable. `binaryOutfile` is
 * rooted under `outDir` when relative; defaults to `join(outDir, serviceName)`.
 */
export const resolveBinaryOutPath = (opts: BinaryOutPathOptions): string => {
  if (opts.binaryOutfile) {
    return isAbsolute(opts.binaryOutfile)
      ? opts.binaryOutfile
      : join(opts.outDir, opts.binaryOutfile);
  }
  return join(opts.outDir, opts.serviceName ?? "ignex");
};
