/**
 * The built-in `Bindings` — assembled from the repo's generated artifacts
 * (`src/generated/*` + `src/schema`). This is the default for every entrypoint
 * (`createServer` / `createClient` / `createNatsBridge`), so all existing code
 * keeps working without passing `bindings`.
 *
 * For your own schema, see `generateBindings` (public/generate.ts) —
 * `defaultBindings` is just the first, built-in instance of the same contract.
 */

import {
  directEncoders,
  directSelfTest,
  directSymbolNames,
  directSymbols,
  hasNulEncoders,
} from "../generated/direct-ser";
import {
  anyEventNameToId,
  controlEventNameToId,
  decodeFrame,
  decodePayload,
  eventNameToId,
  idToAnyEventName,
  idToEventName,
  isControlId,
  readFrameHeader,
  SCHEMA_FINGERPRINT,
  WIRE_HEADER_LEN,
  WIRE_VERSION,
} from "../generated/registry";
import { encodeEventFrame } from "../generated/ts-ser";
import { controlEvents, events } from "../schema";
import { assembleBindings } from "./assemble";

// NOTE: no explicit `: Bindings` annotation on purpose — the concrete
// `events` / `controlEvents` schema types must survive inference so
// `DefaultBindings` (and therefore `EventNameOf` / `EventsOf` on the default
// API) resolves to the built-in `Events` map.
export const defaultBindings = assembleBindings(
  {
    wireVersion: WIRE_VERSION,
    wireHeaderLen: WIRE_HEADER_LEN,
    schemaFingerprint: SCHEMA_FINGERPRINT,
    eventNameToId,
    idToEventName,
    anyEventNameToId,
    idToAnyEventName,
    controlEventNameToId,
    readFrameHeader,
    isControlId,
    decodePayload,
    decodeFrame,
    encodeFrame: encodeEventFrame as (name: string, payload: unknown) => Uint8Array,
    direct: {
      symbols: directSymbols,
      symbolNames: directSymbolNames,
      encoders: directEncoders,
      hasNul: hasNulEncoders,
      selfTest: directSelfTest,
    },
  },
  { events, controlEvents },
  { ffiMode: "required", subjectPrefix: "ignex" },
);
