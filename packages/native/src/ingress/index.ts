/**
 * @fileoverview Public barrel for the direct C-ABI ingress pipeline tree —
 * re-exports the pre-split `ingress.ts` public names so `"./ingress"` resolves
 * identically for existing importers. `IngressLayout` is intentionally NOT
 * re-exported here: no in-repo consumer reaches it through the barrel (its
 * usages are all internal to the `ingress/` tree), and knip flags exactly
 * this one as dead.
 */
export { createNativeIngress, type NativeIngress, type NativeIngressRuntime } from "./factory";
export { buildIngressHeaderPlan, type IngressHeaderPlan } from "./headers";
export {
  type CreateNativeIngressRouterOptions,
  createNativeIngressRouter,
  type NativeIngressRouter,
  type NativeIngressRouterRoute,
} from "./router";
