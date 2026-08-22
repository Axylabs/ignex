/**
 * Public bindings API — `ignex-nova/bindings`.
 *
 *   import { assembleBindings, defaultBindings } from "ignex-nova/bindings";
 *   import type { Bindings, EventsOf } from "ignex-nova/bindings";
 *
 * `defaultBindings` is the built-in registry's wire stack; `assembleBindings`
 * builds a `Bindings` from generated parts (see `ignex-nova/generate`).
 */

export type { AssembleOptions, BindingsParts } from "../src/bindings/assemble";
export { assembleBindings } from "../src/bindings/assemble";
export { defaultBindings } from "../src/bindings/default";
export type {
  Bindings,
  ControlEventNameOf,
  ControlEventsOf,
  DefaultBindings,
  DirectCall,
  DirectEncoder,
  DirectTables,
  EventNameOf,
  EventsOf,
} from "../src/bindings/types";
