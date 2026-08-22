/**
 * `assembleBindings` — build a runtime `Bindings` from generated parts.
 *
 * The generated artifacts (`registry.ts`, `ts-ser.ts`, `direct-ser.ts`) are
 * schema-specific SOURCE produced by `generateBindings` (public/generate.ts).
 * This function wires them into the single `Bindings` object the server /
 * client / NATS bridge accept. It is also what the built-in registry uses
 * (`src/bindings/default.ts`).
 */
import type { TSchema } from "@sinclair/typebox";
import type { Bindings, DirectTables } from "./types";

/** Everything `assembleBindings` needs from the generated artifacts. */
export interface BindingsParts {
  readonly wireVersion: number;
  readonly wireHeaderLen: number;
  readonly schemaFingerprint: number;
  readonly eventNameToId: Readonly<Record<string, number>>;
  readonly idToEventName: Readonly<Record<number, string>>;
  readonly anyEventNameToId: Readonly<Record<string, number>>;
  readonly idToAnyEventName: Readonly<Record<number, string>>;
  readonly controlEventNameToId: Readonly<Record<string, number>>;
  readFrameHeader(bytes: Uint8Array): { name: string; id: number } | null;
  isControlId(id: number): boolean;
  decodePayload(id: number, bytes: Uint8Array): unknown;
  decodeFrame(bytes: Uint8Array): { name: string; id: number; payload: unknown } | null;
  encodeFrame(name: string, payload: unknown): Uint8Array;
  readonly direct?: DirectTables;
}

export interface AssembleOptions {
  /** "required" | "optional" — see `Bindings.ffiMode`. */
  ffiMode?: "required" | "optional";
  /** NATS subject prefix for bridges built from these bindings. */
  subjectPrefix?: string;
}

/**
 * Wire generated parts + the schema registry into a `Bindings` object.
 * `schema.events` / `schema.controlEvents` are the user's TypeBox schemas —
 * they power the `EventsOf<B>` type derivation on the public API.
 */
export function assembleBindings<
  E extends Record<string, TSchema>,
  C extends Record<string, TSchema>,
>(
  parts: BindingsParts,
  schema: { events: E; controlEvents?: C },
  opts: AssembleOptions = {},
): Omit<Bindings, "events" | "controlEvents"> & { events: E; controlEvents: C } {
  const controlEvents = (schema.controlEvents ?? {}) as C;
  const controlIds = new Set<number>(Object.values(parts.controlEventNameToId));
  return {
    wireVersion: parts.wireVersion,
    wireHeaderLen: parts.wireHeaderLen,
    schemaFingerprint: parts.schemaFingerprint,
    ...(opts.subjectPrefix !== undefined ? { subjectPrefix: opts.subjectPrefix } : {}),
    ffiMode: opts.ffiMode ?? "optional",
    events: schema.events,
    controlEvents,
    eventNameToId: parts.eventNameToId,
    idToEventName: parts.idToEventName,
    anyEventNameToId: parts.anyEventNameToId,
    idToAnyEventName: parts.idToAnyEventName,
    controlIds,
    readFrameHeader: parts.readFrameHeader,
    isControlId: parts.isControlId,
    decodePayload: parts.decodePayload,
    decodeFrame: parts.decodeFrame,
    encodeFrame: parts.encodeFrame,
    ...(parts.direct ? { direct: parts.direct } : {}),
  };
}
