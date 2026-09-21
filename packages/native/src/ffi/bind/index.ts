/**
 * @fileoverview C-ABI primary surface bind — barrel re-exporting the lazy
 * singleton accessors (`getFfi`/`isFfiActive`) so existing `"./bind"` imports
 * resolve after the split of the pre-split `ffi/bind.ts` (move-only).
 */

export { getFfi, isFfiActive } from "./access";
