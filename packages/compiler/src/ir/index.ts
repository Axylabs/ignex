/**
 * @fileoverview Route IR — public facade.
 *
 * The compiler's intermediate representation: {@link RouteIR} (with its owned
 * `source` / `analysis` / `decisions` / `codegen` sections) and the lowering
 * step {@link lowerRoute} that produces it from a filename + {@link SourceFile}.
 */

export {
  buildHandlerRef,
  detectConstantResponse,
  findHandlerSymbol,
  lowerRoute,
  parseRouteFilename,
} from "./lower";
export type {
  InlineCandidate,
  RouteIR,
  RouteIRAnalysis,
  RouteIRCodegen,
  RouteIRDecisions,
  RouteIRSource,
} from "./route";
