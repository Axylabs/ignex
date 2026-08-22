/**
 * `generateBindings(schema, options)` — the generic codegen: build the full
 * wire stack (FlatBuffers schema + flatc TS decoders + registry + pure-JS
 * encoder + direct fast-path serde + Rust glue/scaffold + wire registry) for
 * ANY TypeBox schema you define in your app.
 *
 * Usage in your project:
 *
 *   // scripts/generate-bindings.ts
 *   import { generateBindings } from "ignex-nova/generate";
 *   import { schemas, events, controlEvents } from "../src/schema"; // YOUR TypeBox
 *   generateBindings({ schemas, events, controlEvents }, { outDir: "./ignex/generated" }).write();
 *
 *   // app/bindings.ts
 *   import { makeBindings } from "./ignex/generated";   // generated
 *   import * as schema from "../src/schema";            // your TypeBox registry
 *   export const bindings = makeBindings(schema);
 *
 *   // app/server.ts
 *   import { createServer } from "ignex-nova/server";
 *   import { bindings } from "./bindings";
 *   const server = createServer({ port: 3000, bindings, nats: { servers: [...], inbound: true } });
 *   server.publish("yourEvent", {...});                 // typed against YOUR Events
 *
 * Requirements: `flatc` on PATH (the FlatBuffers compiler — same prerequisite
 * as the built-in registry). The Rust side (ffiMode "optional" + `rust: true`)
 * additionally needs a Rust toolchain to BUILD the emitted crate; without it,
 * the server falls back to the pure-JS encoder (correct, slower).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { WIRE_VERSION } from "../src/codegen/constants";
import { emitDirectSer } from "../src/codegen/direct-gen";
import { schemaFingerprint } from "../src/codegen/fingerprint";
import { eventId } from "../src/codegen/hash";
import { emitRegistry } from "../src/codegen/registry-gen";
import { emitRustGlue } from "../src/codegen/rust-glue-gen";
import type { Model } from "../src/codegen/schema-model";
import { buildModel } from "../src/codegen/schema-model";
import { emitTsSer } from "../src/codegen/ts-ser-gen";
import { emitFbs } from "../src/codegen/typebox-to-fbs";
import { controlEvents as standardControlEvents } from "../src/schema";

/** Your TypeBox schema registry — the single source of truth for the wire format. */
export interface SchemaRegistry {
  /** named tables / enums referenced by events (optional — inferred from events). */
  schemas?: Record<string, TSchema>;
  /** app events: name → TypeBox schema (required). */
  events: Record<string, TSchema>;
  /**
   * Extra transport-internal control events (advanced). The STANDARD control
   * events (hello/welcome/subscribe/unsubscribe/joinGroup/leaveGroup/
   * snapshotRequest/ping/pong) are always included — you cannot override or
   * remove them.
   */
  controlEvents?: Record<string, TSchema>;
}

export interface GenerateOptions {
  /** output directory, default "./ignex/generated". */
  outDir?: string;
  /** flatc binary, default "flatc". */
  flatc?: string;
  /** emit the Rust crate scaffold + glue (buildable with cargo), default true. */
  rust?: boolean;
  /**
   * Import specifier for the ignex library in generated code (internal helpers
   * + `assembleBindings`), default "ignex-nova". The package root exports all
   * of them.
   */
  libraryImport?: string;
  /** NATS subject prefix baked into the generated bindings, default "ignex". */
  subjectPrefix?: string;
  /**
   * Server FFI mode for the generated bindings, default "optional":
   *   - "optional" — the Rust addon is used when `IGNEX_FFI_PATH` points at an
   *     addon built from the emitted crate (and it passes self-tests);
   *     otherwise the pure-JS encoder is used.
   *   - "required" — the server throws if the addon is missing / mismatched.
   */
  ffiMode?: "optional" | "required";
  /** wire envelope version (must match the library), default 1. */
  wireVersion?: number;
  /** overwrite `outDir` if it exists, default true. */
  force?: boolean;
}

export interface GeneratedBindings {
  /** the normalized wire model (tables / enums / events). */
  model: Model;
  /** stable schema fingerprint (see `scripts/fingerprint.ts`). */
  fingerprint: number;
  wireVersion: number;
  /** machine-readable event-id registry for NATS consumers / independent clients. */
  wireRegistry: { version: number; fingerprint: number; events: Record<string, number> };
  /** all generated artifacts keyed by relative path (e.g. "ts/backend.ts"). */
  files: Record<string, string>;
  /** write `files` to `outDir`; returns the written relative paths. */
  write(): string[];
}

function run(cmd: string, args: string[], cwd: string, flatc: string): void {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    throw new Error(
      `generateBindings: flatc failed (${res.status}) — is "${flatc}" installed? ` +
        `(brew install flatbuffers / apt install flatbuffers-compiler / download from https://flatbuffers.dev)`,
    );
  }
}

// Rust crate scaffold — the same files the repo's own cdylib is built from,
// so `cargo build --release` in the generated `rust/` dir yields a
// schema-matched addon you can point `IGNEX_FFI_PATH` at.
const RUST_LIB_RS = `//! ignex-nova FFI cdylib (generated for your schema).
pub mod ffi;
pub mod generated;
pub mod transcode;
`;

function rustScaffold(): { lib: string; ffi: string; cargo: string } {
  const here = import.meta.dir;
  const ffi = readFileSync(join(here, "..", "rust", "src", "ffi.rs"), "utf8");
  const lib = RUST_LIB_RS;
  const cargo = `[package]
name = "app-ignex-ffi"
version = "0.1.0"
edition = "2021"

[lib]
name = "ignex_ffi"
crate-type = ["cdylib", "rlib"]
path = "src/lib.rs"

[dependencies]
flatbuffers = "25"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
`;
  return { lib, ffi, cargo };
}

export function generateBindings(
  schema: SchemaRegistry,
  options: GenerateOptions = {},
): GeneratedBindings {
  const wireVersion = options.wireVersion ?? WIRE_VERSION;
  const libraryImport = options.libraryImport ?? "ignex-nova";

  // The standard transport control protocol is always present; users may add
  // custom control events but never override the standard ones.
  const controlSchemas: Record<string, TSchema> = { ...standardControlEvents };
  for (const [name, s] of Object.entries(schema.controlEvents ?? {})) {
    if (name in controlSchemas) {
      throw new Error(
        `generateBindings: control event "${name}" is reserved by the transport protocol — pick a different name`,
      );
    }
    controlSchemas[name] = s;
  }

  const model = buildModel(schema.schemas ?? {}, schema.events, controlSchemas);

  // Stable-hash collision check: every event must have a unique FNV-1a id.
  const seen = new Map<number, string>();
  for (const ev of model.events) {
    const id = eventId(ev.name);
    const existing = seen.get(id);
    if (existing !== undefined) {
      throw new Error(
        `generateBindings: event id collision: "${ev.name}" and "${existing}" both hash to ${id} — rename one of them`,
      );
    }
    seen.set(id, ev.name);
  }

  const fingerprint = schemaFingerprint(model, wireVersion);
  const files: Record<string, string> = {};
  files["backend.fbs"] = emitFbs(model);
  files["wire-registry.json"] =
    JSON.stringify(
      {
        version: wireVersion,
        fingerprint,
        events: Object.fromEntries(model.events.map((ev) => [ev.name, eventId(ev.name)])),
      },
      null,
      2,
    ) + `\n`;

  // flatc → TS decoders (+ Rust generated code when rust !== false)
  const flatcBin = options.flatc ?? "flatc";
  const tmp = mkdtempSync(join(tmpdir(), "ignex-gen-"));
  const fbsPath = join(tmp, "backend.fbs");
  writeFileSync(fbsPath, files["backend.fbs"]);
  try {
    const tsOut = join(tmp, "ts");
    mkdirSync(tsOut, { recursive: true });
    run(flatcBin, ["--ts", "--gen-object-api", "-o", tsOut, fbsPath], tmp, flatcBin);
    for (const f of readdirSync(tsOut)) {
      files[`ts/${f}`] = readFileSync(join(tsOut, f), "utf8");
    }

    if (options.rust !== false) {
      const rustOut = join(tmp, "rust");
      mkdirSync(rustOut, { recursive: true });
      run(flatcBin, ["--rust", "-o", rustOut, fbsPath], tmp, flatcBin);
      const rs = readdirSync(rustOut).filter((f) => f.endsWith("_generated.rs"));
      if (rs.length !== 1) {
        throw new Error(
          `generateBindings: expected exactly one .rs from flatc --rust, got: [${rs.join(", ")}]`,
        );
      }
      const scaffold = rustScaffold();
      files["rust/src/generated/backend.rs"] = readFileSync(join(rustOut, rs[0]!), "utf8");
      files["rust/src/generated/mod.rs"] =
        "// @generated by ignex-nova generate — DO NOT EDIT\npub mod backend;\n";
      files["rust/src/transcode/generated.rs"] = emitRustGlue(model, fingerprint);
      files["rust/src/transcode/mod.rs"] =
        "// @generated by ignex-nova generate — DO NOT EDIT\npub mod generated;\n";
      files["rust/src/lib.rs"] = scaffold.lib;
      files["rust/src/ffi.rs"] = scaffold.ffi;
      files["rust/Cargo.toml"] = scaffold.cargo;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Generated TS stack (user mode: self-contained local types + library imports)
  files["registry.ts"] = emitRegistry(model, fingerprint, { schemaImport: null, libraryImport });
  files["direct-ser.ts"] = emitDirectSer(model, { schemaImport: null, libraryImport });
  files["ts-ser.ts"] = emitTsSer(model, { schemaImport: null });

  const subjectPrefix = options.subjectPrefix ?? "ignex";
  const ffiMode = options.ffiMode ?? "optional";
  files["index.ts"] = emitIndex(
    model,
    libraryImport,
    subjectPrefix,
    ffiMode,
    wireVersion,
    fingerprint,
  );

  files["README.md"] = emitReadme();

  const write = (): string[] => {
    const outDir = options.outDir ?? "./ignex/generated";
    if (existsSync(outDir)) {
      if (options.force === false)
        throw new Error(
          `generateBindings: "${outDir}" already exists (pass force: true to overwrite)`,
        );
      rmSync(outDir, { recursive: true, force: true });
    }
    mkdirSync(outDir, { recursive: true });
    const written: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const p = join(outDir, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      written.push(rel);
    }
    return written;
  };

  return {
    model,
    fingerprint,
    wireVersion,
    wireRegistry: JSON.parse(files["wire-registry.json"]!) as {
      version: number;
      fingerprint: number;
      events: Record<string, number>;
    },
    files,
    write,
  };
}

function emitIndex(
  model: Model,
  libraryImport: string,
  subjectPrefix: string,
  ffiMode: "optional" | "required",
  wireVersion: number,
  fingerprint: number,
): string {
  const appEvents = model.events
    .filter((e) => !e.control)
    .map((e) => `"${e.name}"`)
    .join(" | ");
  const ctlEvents = model.events
    .filter((e) => e.control)
    .map((e) => `"${e.name}"`)
    .join(" | ");
  const lines: string[] = [];
  lines.push("// @generated by ignex-nova generate — DO NOT EDIT");
  lines.push(`import { assembleBindings } from ${JSON.stringify(libraryImport)};`);
  lines.push('import type { TSchema } from "@sinclair/typebox";');
  lines.push('import * as reg from "./registry";');
  lines.push('import { encodeEventFrame } from "./ts-ser";');
  lines.push(
    'import { directSymbols, directSymbolNames, directEncoders, hasNulEncoders, directSelfTest } from "./direct-ser";',
  );
  lines.push("");
  lines.push('export * from "./registry";');
  lines.push("");
  lines.push("/** machine-readable wire registry for NATS consumers / independent clients. */");
  lines.push(
    `export const wireRegistry = ${JSON.stringify(
      {
        version: wireVersion,
        fingerprint,
        events: Object.fromEntries(model.events.map((ev) => [ev.name, eventId(ev.name)])),
      },
      null,
      2,
    )};`,
  );
  lines.push("");
  lines.push("/**");
  lines.push(" * Assemble a runtime `Bindings` from this generated stack.");
  lines.push(" * `schema` is YOUR TypeBox registry: `{ events, controlEvents? }` —");
  lines.push(" * the same objects you passed to `generateBindings`. The returned");
  lines.push(" * bindings type derives from it, so `createServer` / `createClient`");
  lines.push(" * are fully typed against your events.");
  lines.push(" */");
  lines.push("export function makeBindings<");
  lines.push("  E extends Record<string, TSchema>,");
  lines.push("  C extends Record<string, TSchema>,");
  lines.push(">(schema: { events: E; controlEvents?: C }) {");
  lines.push("  return assembleBindings(");
  lines.push("    {");
  lines.push("      wireVersion: reg.WIRE_VERSION,");
  lines.push("      wireHeaderLen: reg.WIRE_HEADER_LEN,");
  lines.push("      schemaFingerprint: reg.SCHEMA_FINGERPRINT,");
  lines.push("      eventNameToId: reg.eventNameToId,");
  lines.push("      idToEventName: reg.idToEventName,");
  lines.push("      anyEventNameToId: reg.anyEventNameToId,");
  lines.push("      idToAnyEventName: reg.idToAnyEventName,");
  lines.push("      controlEventNameToId: reg.controlEventNameToId,");
  lines.push("      readFrameHeader: reg.readFrameHeader,");
  lines.push("      isControlId: reg.isControlId,");
  lines.push("      decodePayload: reg.decodePayload,");
  lines.push("      decodeFrame: reg.decodeFrame,");
  lines.push("      encodeFrame: encodeEventFrame,");
  lines.push("      direct: {");
  lines.push("        symbols: directSymbols,");
  lines.push("        symbolNames: directSymbolNames,");
  lines.push("        encoders: directEncoders,");
  lines.push("        hasNul: hasNulEncoders,");
  lines.push("        selfTest: directSelfTest,");
  lines.push("      },");
  lines.push("    },");
  lines.push("    schema,");
  lines.push(
    `    { ffiMode: ${JSON.stringify(ffiMode)}, subjectPrefix: ${JSON.stringify(subjectPrefix)} },`,
  );
  lines.push("  );");
  lines.push("}");
  lines.push("");
  lines.push(`export type EventName = ${appEvents};`);
  lines.push(`export type ControlEventName = ${ctlEvents};`);
  lines.push("");
  return lines.join("\n");
}

function emitReadme(): string {
  return [
    "# Generated bindings",
    "",
    "Generated by `ignex-nova generate` (public/generate.ts) — DO NOT EDIT by hand.",
    "",
    "## Use",
    "",
    "```ts",
    "// bindings.ts",
    'import { makeBindings } from "./ignex/generated";',
    'import * as schema from "../src/schema"; // your TypeBox registry',
    "export const bindings = makeBindings(schema);",
    "```",
    "",
    "```ts",
    'import { createServer } from "ignex-nova/server";',
    'import { createClient } from "ignex-nova/client";',
    'import { createNatsBridge } from "ignex-nova/nats";',
    'import { bindings } from "./bindings";',
    "",
    'const server = createServer({ port: 3000, bindings, nats: { servers: ["nats://localhost:4222"], inbound: true } });',
    'const client = createClient("ws://localhost:3000/ws", { bindings });',
    "",
    "See docs/generic-bindings.md in the ignex-nova package for the full guide",
    "(including the Rust FFI fast path and NATS horizontal scaling).",
    "",
  ].join("\n");
}
