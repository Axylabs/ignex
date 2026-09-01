/**
 * Ambient declaration for babel-preset-solid — the package ships no types.
 * See scripts/gen-debug-ui.ts (the Solid JSX compiler pass).
 */

declare module "babel-preset-solid" {
  import type { PresetAPI, PresetObject } from "@babel/core";

  interface SolidPresetOptions {
    /** Compilation target: "dom" (default), "ssr", "universal", "static". */
    generate?: "dom" | "ssr" | "universal" | "static";
    hydratable?: boolean;
    delegateEvents?: boolean;
    moduleName?: string;
    builtIns?: string[];
    contextToCustomElements?: boolean;
    wrapConditionals?: boolean;
    topLevelAwait?: boolean;
  }

  /** Plain preset function (the package ships no types; options are loose). */
  const preset: (api: PresetAPI, options: object, dirname: string) => PresetObject;
  export default preset;
  export type { SolidPresetOptions };
}
