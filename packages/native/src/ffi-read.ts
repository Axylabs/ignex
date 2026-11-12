/**
 * @fileoverview Runtime-native scalar/string reads, owned by castrum and
 * re-exported unchanged for Ignex's packed-route decoders.
 */

export type { FfiBuf } from "@ignex/castrum/native";
export { ffiBuf, ffiString, ffiU32, ffiU64 } from "@ignex/castrum/native";
