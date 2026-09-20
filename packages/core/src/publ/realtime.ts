/**
 * @fileoverview Public sub-barrel: the realtime RPC kit re-exported from the
 * `@ignex/core` entry (split from the barrel `src/index.ts` by section banner —
 * move-only; `export` statements verbatim).
 */

// ── realtime rpc ────────────────────────────────────────────────
export type {
  RpcKitCompiledValidator,
  RpcKitContext,
  RpcKitMethod,
  RpcKitOptions,
  RpcKitSchema,
  RpcManifestDoc,
} from "../rpc/kit";
export { createRpcKit } from "../rpc/kit";
