/**
 * @fileoverview Native addon state backed by castrum's configured runtime bridge.
 * Castrum owns package/binary resolution, Node-API loading, FFI binding, CPU
 * detection, and transport self-tests; this module only applies Ignex's
 * environment contract and never-throws fallback policy.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { NativeBridge } from "@ignex/castrum/native";
import { isNativeSurface, normalize, reportLoadFailure } from "./require";
import type { NativeAddon } from "./types";

type NativeBridgeModule = typeof import("@ignex/castrum/native");

/** Resolve castrum through the app's existing core → native dependency chain. */
export const resolveNativeModuleUrl = (subpath: "" | "/native"): string => {
  const corePkg = createRequire(import.meta.url).resolve("@ignex/core/package.json");
  const nativeEntry = createRequire(corePkg).resolve("@ignex/native");
  const entry = createRequire(nativeEntry).resolve(`@ignex/castrum${subpath}`);
  return pathToFileURL(entry).href;
};

const loadNativeBridge = async (): Promise<NativeBridgeModule> => {
  try {
    return await import("@ignex/castrum/native");
  } catch (directError) {
    try {
      return (await import(resolveNativeModuleUrl("/native"))) as NativeBridgeModule;
    } catch {
      throw directError;
    }
  }
};

/** The loaded addon (or `null` when unavailable). Shared module state. */
export let native: NativeAddon | null = null;

let bridge: NativeBridge | null = null;

const init = (async (): Promise<void> => {
  if (process.env.IGNEX_NATIVE === "off") return;

  try {
    const override = process.env.IGNEX_NATIVE_PATH;
    if (override && !override.endsWith(".node")) {
      const mod = await import(override);
      const surface = normalize(mod);
      native = isNativeSurface(surface) ? surface : null;
      return;
    }

    const { createNativeBridge } = await loadNativeBridge();
    const rawMode = process.env.IGNEX_FFI_MODE;
    bridge = createNativeBridge({
      ...(override ? { addonPath: override } : {}),
      ffiMode: rawMode === "ffi" || rawMode === "napi" ? rawMode : "auto",
    });
    native = bridge.addon as unknown as NativeAddon;
  } catch (err) {
    native = null;
    bridge = null;
    reportLoadFailure(err);
  }
})();

await init;

/** The loaded addon (or `null` when unavailable). */
export const getNative = (): NativeAddon | null => native;

/** Castrum's shared native bridge (or `null` when unavailable). */
export const getNativeBridge = (): NativeBridge | null => bridge;

/** True when the Rust addon is present and usable. */
export const isNativeAvailable = (): boolean => native != null;
