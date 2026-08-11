/**
 * @fileoverview Source frontend — public facade.
 *
 * The compiler's standard "input" layer: {@link SourceManager} reads + parses
 * each file exactly once into a {@link SourceFile} (retained AST), which every
 * later phase consumes instead of re-reading source.
 */

export type { SourceFile } from "./source-file";
export { SourceManager } from "./source-manager";
