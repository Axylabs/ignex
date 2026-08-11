/**
 * @fileoverview Route IR — the compiler's intermediate representation.
 *
 * Standard compilers lower source into a typed IR that every later phase
 * transforms. `RouteIR` is that object for a single route. It is split into
 * four clearly-owned sections so each phase reads/writes only its own data
 * instead of mutating one grab-bag object:
 *
 * - {@link RouteIRSource}   — immutable source facts lowered from the route
 *   filename + module AST (method, path, params, module linkage).
 * - {@link RouteIRAnalysis} — semantic facts attached by the analysis phase
 *   (usage, hooks, hotness, constant response, validation flag).
 * - {@link RouteIRDecisions}— decisions made by optimization + precompile
 *   (inline eligibility, dedup group, inline candidate, validators,
 *   serializers, schema doc). Owned by those phases.
 * - {@link RouteIRCodegen}  — codegen-owned identifiers (e.g. `handlerRef`).
 *
 * `RouteDef` in `types.ts` is a deprecated alias of `RouteIR`.
 */

import type { ContextUsage } from "@ignus/shared";
import type {
  HttpMethod,
  ResponseType,
  RouteCacheConfig,
  RouteSerializers,
  RouteValidators,
} from "../types";

/**
 * Source facts lowered from the route filename + the module's retained AST.
 * Immutable for the whole build — phases never rewrite these.
 */
export interface RouteIRSource {
  readonly method: HttpMethod;
  readonly path: string;
  readonly paramNames: readonly string[];
  readonly isDynamic: boolean;
  readonly isStatic: boolean;
  readonly segmentCount: number;
  readonly file: string;
  /** Index into the build's module table (`DiscoveryResult.modules`). */
  readonly moduleIdx: number;
}

/**
 * Semantic-analysis facts attached during the analysis phase. Phases that
 * refine these (e.g. hotness) produce a new IR via immutable update.
 */
export interface RouteIRAnalysis {
  readonly isAsync: boolean;
  readonly responseType: ResponseType;
  readonly hasValidation: boolean;
  readonly hotnessScore: number;
  readonly hooks: readonly string[];
  readonly isConstantResponse: boolean;
  readonly constantResponse?: string;
  readonly usage: ContextUsage;
  readonly config?: Record<string, unknown>;
  readonly cache?: RouteCacheConfig;
  readonly handlerExportName?: string;
}

/** A handler body transpiled to plain JS, ready to be inlined. */
export interface InlineCandidate {
  readonly body: string;
  readonly isAsync: boolean;
  readonly param: string;
}

/**
 * Optimizer + precompile decisions — the phase-owned mutable section. The
 * optimization phase sets `shouldInline` / `dedupGroup` / `inlineCandidate`;
 * validator/serializer precompilation sets `validators` / `serializers` /
 * `schemaDoc`. Codegen only reads this section.
 */
export interface RouteIRDecisions {
  readonly shouldInline: boolean;
  readonly dedupGroup?: string;
  readonly inlineCandidate?: InlineCandidate;
  readonly validators?: RouteValidators;
  readonly serializers?: RouteSerializers;
  readonly schemaDoc?: Record<string, unknown>;
}

/** Codegen-owned identifiers assigned at lowering, consumed by emission. */
export interface RouteIRCodegen {
  readonly handlerRef: string;
}

/** The compiled IR for a single route. */
export interface RouteIR {
  readonly source: RouteIRSource;
  readonly analysis: RouteIRAnalysis;
  readonly decisions: RouteIRDecisions;
  readonly codegen: RouteIRCodegen;
}
