/**
 * @fileoverview Route IR — public facade.
 *
 * The compiler's intermediate representation: {@link RouteIR} (with its owned
 * `source` / `analysis` / `decisions` / `codegen` sections, defined in
 * `./route`) and the lowering step {@link lowerRoute} that produces it from a
 * filename + {@link SourceFile}. The canonical public type path for `RouteIR`
 * is the package root (`src/index.ts` re-exports it from `./types`).
 */

export { lowerRoute, parseRouteFilename } from "./lower";
