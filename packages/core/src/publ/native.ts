/**
 * @fileoverview Public sub-barrel: the `@ignex/native` execution surface
 * re-exported from the `@ignex/core` entry (split from the barrel `src/index.ts`
 * by section banner — move-only; `export` statements verbatim).
 */

// ── unified execution API (@ignex/native) ────────────────────────
// The single runtime-switch facade: `backend.*` binds every primitive to its
// fastest implementation (castrum native on Bun vs pure-TS fallback), driven
// by the `SELECTION` table in @ignex/native. `SELECTION` is read-only data —
// treat it as a snapshot, not something to mutate.
export {
  backend,
  backendName,
  clearNativeSchemaCache,
  createExecutionBackend,
  createNativeRoute,
  createTaskRuntime,
  csrfVerifyBatch,
  type DegradationEvent,
  type DegradationKind,
  degradationCounts,
  degradationTotal,
  type ExecutionBackend,
  type ExecutionOpStatus,
  type ExecutionStatus,
  executionStatus,
  type FlushNativeMemoryOptions,
  flushNativeMemory,
  hmacSha256Batch,
  hmacSha256VerifyBatch,
  type IgnexExecution,
  implFor,
  initNative,
  isNativeAvailable,
  isNativeTaskRuntime,
  type NativeRoute,
  type NativeRouteFrame,
  type NativeRoutePlan,
  type NativeRouteRunResult,
  type NativeRouteSnapshot,
  nativeRouteHandler,
  type OpDecision,
  type OpName,
  type Pbkdf2RunOptions,
  SELECTION,
  setNativeTelemetrySink,
  signCookieBatch,
  type TaskRunOptions,
  type TaskRuntime,
  type TaskRuntimeOptions,
  type TaskStats,
  useNative,
  validateEmail,
  validateIpv4,
  validateIpv6,
  validateUuid,
  verifyCookieBatch,
  verifyPasswordAsync,
} from "@ignex/native";
