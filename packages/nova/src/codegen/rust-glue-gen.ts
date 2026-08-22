import { WIRE_HEADER_LEN, WIRE_VERSION } from "./constants";
import { eventId } from "./hash";
import type { EventDef, FieldDef, Model } from "./schema-model";
import { isDirectableEvent, toSnake } from "./schema-model";

function rustTypeOf(f: FieldDef): string {
  switch (f.kind) {
    case "string":
      return f.required ? "String" : "Option<String>";
    case "double":
      return "f64";
    case "int64":
      return "i64";
    case "bool":
      return "bool";
    case "enum":
      return "Option<String>";
    case "table":
      return `Option<${f.tableName}Json>`;
    case "vector-string":
      return "Vec<String>";
    case "vector-double":
      return "Vec<f64>";
    case "vector-int64":
      return "Vec<i64>";
    case "vector-bool":
      return "Vec<bool>";
    case "vector-enum":
      return "Vec<String>";
    case "vector-table":
      return `Vec<${f.tableName}Json>`;
  }
}

function serdeAttr(f: FieldDef): string {
  return f.kind === "int64"
    ? '#[serde(default, deserialize_with = "de_i64")]'
    : "#[serde(default)]";
}

/** Statements that build any needed offsets before `Xxx::create(...)`. */
function buildFieldExprs(f: FieldDef): string {
  const fb = f.fbName;
  switch (f.kind) {
    case "string":
      return f.required
        ? `let ${fb} = fbb.create_string(&j.${fb});`
        : `let ${fb} = j.${fb}.as_deref().map(|s| fbb.create_string(s));`;
    case "double":
    case "int64":
    case "bool":
      return "";
    case "enum":
      return `let ${fb} = j.${fb}.as_deref().map(${toSnake(f.enumName!)}_from_str).unwrap_or_default();`;
    case "table":
      return `let ${fb} = j.${fb}.as_ref().map(|c| build_${toSnake(f.tableName!)}(fbb, c));`;
    case "vector-string":
      return (
        `let ${fb} = if j.${fb}.is_empty() { None } else { ` +
        `let offs: Vec<flatbuffers::WIPOffset<&str>> = j.${fb}.iter().map(|s| fbb.create_string(s)).collect(); ` +
        `Some(fbb.create_vector(&offs)) };`
      );
    case "vector-double":
    case "vector-int64":
    case "vector-bool":
      return `let ${fb} = if j.${fb}.is_empty() { None } else { Some(fbb.create_vector(&j.${fb})) };`;
    case "vector-enum":
      return (
        `let ${fb} = if j.${fb}.is_empty() { None } else { ` +
        `let vals: Vec<backend::${f.enumName}> = j.${fb}.iter().map(|s| ${toSnake(f.enumName!)}_from_str(s)).collect(); ` +
        `Some(fbb.create_vector(&vals)) };`
      );
    case "vector-table":
      return (
        `let ${fb} = if j.${fb}.is_empty() { None } else { ` +
        `let offs: Vec<flatbuffers::WIPOffset<backend::${f.tableName}<'a>>> = ` +
        `j.${fb}.iter().map(|c| build_${toSnake(f.tableName!)}(fbb, c)).collect(); ` +
        `Some(fbb.create_vector(&offs)) };`
      );
  }
}

function argsExpr(f: FieldDef): string {
  const fb = f.fbName;
  switch (f.kind) {
    case "string":
      return f.required ? `${fb}: Some(${fb}),` : `${fb},`;
    case "double":
    case "int64":
    case "bool":
      return `${fb}: j.${fb},`;
    default:
      return `${fb},`;
  }
}

function emitJsonStruct(f: FieldDef): string {
  const ty = rustTypeOf(f);
  return `    ${serdeAttr(f)}\n    pub ${f.fbName}: ${ty},`;
}

function emitBuildFn(_m: Model, t: { name: string; fields: FieldDef[] }): string {
  const snake = toSnake(t.name);
  const exprs = t.fields
    .map(buildFieldExprs)
    .filter((s) => s.length > 0)
    .join("\n    ");
  const args = t.fields.map(argsExpr).join("\n        ");
  const lines = [
    `pub fn build_${snake}<'a>(fbb: &mut flatbuffers::FlatBufferBuilder<'a>, j: &${t.name}Json) -> flatbuffers::WIPOffset<backend::${t.name}<'a>> {`,
    `    ${exprs}`,
    `    backend::${t.name}::create(fbb, &backend::${t.name}Args {`,
    `        ${args}`,
    `        ..Default::default()`,
    `    })`,
    `}`,
  ];
  return lines.join("\n");
}

function emitSerializeFn(_m: Model, ev: { name: string; tableName: string }): string {
  const snake = toSnake(ev.name);
  const lines = [
    `pub fn serialize_${snake}(json: &[u8], out: &mut [u8]) -> Result<usize, TranscodeError> {`,
    `    let j: ${ev.tableName}Json = serde_json::from_slice(json).map_err(|_| TranscodeError::Parse)?;`,
    `    copy_finished(out, |fbb| build_${toSnake(ev.tableName)}(fbb, &j))`,
    `}`,
  ];
  return lines.join("\n");
}

/**
 * Direct-args helpers: emit an `extern "C"` fn per flat event that takes the
 * JS object's fields directly (strings as cstring, scalars as numbers, enums as
 * u32 index) — no JSON.stringify / serde_json on the hot path.
 */
function directArgDecl(f: FieldDef): string {
  switch (f.kind) {
    case "string":
      // cstring ARG — the engine transcodes the JS string in-engine (zero JS
      // encode); Rust borrows via CStr::from_ptr, no length arg, no from_utf8
      // validation (the caller's string is always valid UTF-8).
      return `${f.fbName}: *const c_char,`;
    case "double":
      return `${f.fbName}: f64,`;
    case "int64":
      return `${f.fbName}: i64,`;
    case "bool":
      return `${f.fbName}: u8,`;
    case "enum":
      return `${f.fbName}: u32,`;
    case "vector-table":
    case "vector-string":
    case "vector-double":
    case "vector-int64":
    case "vector-bool":
    case "vector-enum":
      // packed binary blob: (ptr, len)
      return `${f.fbName}_ptr: *const u8,\n    ${f.fbName}_len: usize,`;
    default:
      throw new Error(`direct-args: unsupported field kind ${f.kind}`);
  }
}

function directDecodeLines(f: FieldDef): string {
  const fb = f.fbName;
  switch (f.kind) {
    case "string":
      // cstring arg: null → empty/None; else borrow without UTF-8 validation
      // (`from_utf8_unchecked` — the engine transcoded valid UTF-8).
      if (f.required) {
        return `let ${fb} = if ${fb}.is_null() { "" } else { std::str::from_utf8_unchecked(CStr::from_ptr(${fb}).to_bytes()) };`;
      }
      return `let ${fb} = if ${fb}.is_null() { None } else { Some(std::str::from_utf8_unchecked(CStr::from_ptr(${fb}).to_bytes())) };`;
    case "enum":
      return `let ${fb} = backend::${f.enumName}(${fb} as i32);`;
    default:
      return "";
  }
}

function directBuildLines(f: FieldDef, parent: string): string {
  const fb = f.fbName;
  switch (f.kind) {
    case "string":
      return f.required
        ? `let ${fb} = fbb.create_string(${fb});`
        : `let ${fb} = ${fb}.map(|s| fbb.create_string(s));`;
    case "vector-table":
    case "vector-string":
    case "vector-double":
    case "vector-int64":
    case "vector-bool":
    case "vector-enum":
      return `let ${fb} = read_packed_${toSnake(parent)}_${fb}(fbb, ${fb}_ptr, ${fb}_len);`;
    default:
      return "";
  }
}

function directArgAssign(f: FieldDef): string {
  const fb = f.fbName;
  switch (f.kind) {
    case "string":
      return f.required ? `${fb}: Some(${fb}),` : `${fb},`;
    case "double":
    case "int64":
      return `${fb}: ${fb},`;
    case "bool":
      return `${fb}: ${fb} != 0,`;
    case "enum":
    case "vector-table":
    case "vector-string":
    case "vector-double":
    case "vector-int64":
    case "vector-bool":
    case "vector-enum":
      return `${fb},`;
    default:
      throw new Error(`direct-args: unsupported field kind ${f.kind}`);
  }
}

/** Packed-vector readers: decode a JS-packed binary blob into a FlatBuffer vector. */
function isVectorKind(kind: string): boolean {
  return [
    "vector-table",
    "vector-string",
    "vector-double",
    "vector-int64",
    "vector-bool",
    "vector-enum",
  ].includes(kind);
}

function emitPackedElemRead(ef: FieldDef): string {
  const fb = ef.fbName;
  switch (ef.kind) {
    case "string":
      return `let ${fb}_len = read_u32(b, &mut off) as usize; let ${fb} = std::str::from_utf8(&b[off..off + ${fb}_len]).unwrap_or(""); off += ${fb}_len; let ${fb}_off = fbb.create_string(${fb});`;
    case "double":
      return `let ${fb} = read_f64(b, &mut off);`;
    case "int64":
      return `let ${fb} = read_i64(b, &mut off);`;
    case "bool":
      return `let ${fb} = b[off] != 0; off += 1;`;
    case "enum":
      return `let ${fb} = backend::${ef.enumName}(read_u32(b, &mut off) as i32);`;
    default:
      throw new Error(`packed element: unsupported field kind ${ef.kind}`);
  }
}

function emitPackedElemAssign(ef: FieldDef): string {
  const fb = ef.fbName;
  switch (ef.kind) {
    case "string":
      return `${fb}: Some(${fb}_off),`;
    case "double":
    case "int64":
    case "bool":
    case "enum":
      return `${fb},`;
    default:
      throw new Error(`packed element: unsupported field kind ${ef.kind}`);
  }
}

function emitPackedReader(m: Model, parent: string, f: FieldDef): string {
  const name = `read_packed_${toSnake(parent)}_${f.fbName}`;
  const lines: string[] = [];
  if (f.kind === "vector-table") {
    const elem = m.tables.find((e) => e.name === f.tableName)!;
    lines.push(
      `fn ${name}<'a>(fbb: &mut flatbuffers::FlatBufferBuilder<'a>, ptr: *const u8, len: usize) -> Option<flatbuffers::WIPOffset<flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<backend::${f.tableName}<'a>>>>> {`,
    );
    lines.push(`    if ptr.is_null() || len == 0 { return None; }`);
    lines.push(`    let b = unsafe { std::slice::from_raw_parts(ptr, len) };`);
    lines.push(`    let mut off = 0usize;`);
    lines.push(`    let count = read_u32(b, &mut off) as usize;`);
    lines.push(
      `    let mut offsets: Vec<flatbuffers::WIPOffset<backend::${f.tableName}<'a>>> = Vec::with_capacity(count);`,
    );
    lines.push(`    for _ in 0..count {`);
    for (const ef of elem.fields) lines.push(`        ${emitPackedElemRead(ef)}`);
    lines.push(
      `        let item = backend::${f.tableName}::create(fbb, &backend::${f.tableName}Args {`,
    );
    for (const ef of elem.fields) lines.push(`            ${emitPackedElemAssign(ef)}`);
    lines.push(`            ..Default::default()`);
    lines.push(`        });`);
    lines.push(`        offsets.push(item);`);
    lines.push(`    }`);
    lines.push(`    Some(fbb.create_vector(&offsets))`);
    lines.push(`}`);
    return lines.join("\n");
  }
  const elemTy = (
    {
      "vector-double": "f64",
      "vector-int64": "i64",
      "vector-bool": "bool",
      "vector-string": "flatbuffers::ForwardsUOffset<&'a str>",
      "vector-enum": `backend::${f.enumName}`,
    } as Record<string, string>
  )[f.kind]!;
  const vecInner = f.kind === "vector-string" ? "flatbuffers::WIPOffset<&'a str>" : elemTy;
  lines.push(
    `fn ${name}<'a>(fbb: &mut flatbuffers::FlatBufferBuilder<'a>, ptr: *const u8, len: usize) -> Option<flatbuffers::WIPOffset<flatbuffers::Vector<'a, ${elemTy}>>> {`,
  );
  lines.push(`    if ptr.is_null() || len == 0 { return None; }`);
  lines.push(`    let b = unsafe { std::slice::from_raw_parts(ptr, len) };`);
  lines.push(`    let mut off = 0usize;`);
  lines.push(`    let count = read_u32(b, &mut off) as usize;`);
  lines.push(`    let mut vals: Vec<${vecInner}> = Vec::with_capacity(count);`);
  lines.push(`    for _ in 0..count {`);
  if (f.kind === "vector-double") lines.push(`        vals.push(read_f64(b, &mut off));`);
  else if (f.kind === "vector-int64") lines.push(`        vals.push(read_i64(b, &mut off));`);
  else if (f.kind === "vector-bool") lines.push(`        vals.push(b[off] != 0); off += 1;`);
  else if (f.kind === "vector-string")
    lines.push(
      `        let l = read_u32(b, &mut off) as usize; let s = std::str::from_utf8(&b[off..off + l]).unwrap_or(""); off += l; vals.push(fbb.create_string(s));`,
    );
  else if (f.kind === "vector-enum")
    lines.push(`        vals.push(backend::${f.enumName}(read_u32(b, &mut off) as i32));`);
  lines.push(`    }`);
  lines.push(`    Some(fbb.create_vector(&vals))`);
  lines.push(`}`);
  return lines.join("\n");
}

function emitPackedReaders(m: Model): string[] {
  const directEvents = m.events.filter((ev) => isDirectableEvent(m, ev));
  const vectorFields: { parent: string; f: FieldDef }[] = [];
  for (const ev of directEvents) {
    const table = m.tables.find((t) => t.name === ev.tableName)!;
    for (const f of table.fields)
      if (isVectorKind(f.kind)) vectorFields.push({ parent: table.name, f });
  }
  if (vectorFields.length === 0) return [];
  const lines: string[] = [
    "fn read_u32(b: &[u8], off: &mut usize) -> u32 {",
    "    let v = u32::from_le_bytes([b[*off], b[*off + 1], b[*off + 2], b[*off + 3]]);",
    "    *off += 4;",
    "    v",
    "}",
    "",
    "fn read_i64(b: &[u8], off: &mut usize) -> i64 {",
    "    let mut buf = [0u8; 8];",
    "    buf.copy_from_slice(&b[*off..*off + 8]);",
    "    *off += 8;",
    "    i64::from_le_bytes(buf)",
    "}",
    "",
    "fn read_f64(b: &[u8], off: &mut usize) -> f64 {",
    "    f64::from_bits(read_i64(b, off) as u64)",
    "}",
    "",
  ];
  for (const { parent, f } of vectorFields) {
    lines.push(emitPackedReader(m, parent, f));
    lines.push("");
  }
  return lines;
}

function emitDirectFn(m: Model, ev: EventDef): string {
  const table = m.tables.find((t) => t.name === ev.tableName)!;
  const id = eventId(ev.name);
  const snake = toSnake(ev.name);
  const decls = table.fields.map(directArgDecl).join("\n    ");
  const decodes = table.fields
    .map(directDecodeLines)
    .filter((s) => s.length > 0)
    .join("\n        ");
  const builds = table.fields
    .map((f) => directBuildLines(f, table.name))
    .filter((s) => s.length > 0)
    .join("\n            ");
  const assigns = table.fields.map(directArgAssign).join("\n                ");
  return [
    `#[no_mangle]`,
    `pub unsafe extern "C" fn fb_${snake}_serialize(`,
    `    ${decls}`,
    `    out: *mut u8,`,
    `    out_cap: usize,`,
    `) -> usize {`,
    `    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`,
    `        if out.is_null() && out_cap != 0 {`,
    `            return 0;`,
    `        }`,
    `        ${decodes}`,
    `        // envelope = [WIRE_VERSION:1][event_id:u32 LE]; flatbuffer payload follows`,
    `        let payload: &mut [u8] = if out_cap < WIRE_HEADER_LEN {`,
    `            &mut []`,
    `        } else {`,
    `            std::slice::from_raw_parts_mut(out.add(WIRE_HEADER_LEN), out_cap - WIRE_HEADER_LEN)`,
    `        };`,
    `        match copy_finished(payload, |fbb| {`,
    `            ${builds}`,
    `            backend::${ev.tableName}::create(fbb, &backend::${ev.tableName}Args {`,
    `                ${assigns}`,
    `                ..Default::default()`,
    `            })`,
    `        }) {`,
    `            Ok(written) => {`,
    `                let needed = written + WIRE_HEADER_LEN;`,
    `                if needed <= out_cap {`,
    `                    *out.add(0) = WIRE_VERSION;`,
    `                    let id_bytes = ${id}u32.to_le_bytes();`,
    `                    std::ptr::copy_nonoverlapping(id_bytes.as_ptr(), out.add(1), 4);`,
    `                }`,
    `                needed`,
    `            }`,
    `            Err(_) => 0,`,
    `        }`,
    `    }))`,
    `    .unwrap_or(0)`,
    `}`,
  ].join("\n");
}

/**
 * TypeBox model → Rust JSON→FlatBuffer glue. Emits, per table: a serde JSON
 * struct + a `build_*` fn that calls the flatc-generated `backend::<T>::create`
 * with `XxxArgs`. Per event: a `serialize_<event>` that finishes a
 * size-prefixed buffer. Plus a shared `serialize_event(event_id, ...)` dispatcher
 * used by the C-ABI `fb_serialize` export. Event ids are STABLE FNV-1a 32-bit
 * hashes of the event name, matching `generated/registry.ts`. The frame
 * envelope `[WIRE_VERSION][event_id:u32]` is written by the C-ABI layer.
 */
export function emitRustGlue(m: Model, fingerprint: number): string {
  const lines: string[] = [];
  lines.push("// @generated by src/codegen/rust-glue-gen.ts — DO NOT EDIT");
  lines.push("#![allow(clippy::all)]");
  lines.push("#![allow(dead_code)]");
  lines.push("#![allow(unused_imports)]");
  lines.push("");
  lines.push("use std::cell::RefCell;");
  lines.push("use std::ffi::CStr;");
  lines.push("use std::os::raw::c_char;");
  lines.push("use serde::Deserialize;");
  lines.push("use crate::generated::backend;");
  lines.push("");
  lines.push(`pub const WIRE_VERSION: u8 = ${WIRE_VERSION};`);
  lines.push(
    `pub const WIRE_HEADER_LEN: usize = ${WIRE_HEADER_LEN}; // [version:1][event_id:u32 LE]`,
  );
  lines.push(`pub const SCHEMA_FINGERPRINT: u64 = ${fingerprint}; // fnv1a32(canonical model)`);
  lines.push("");
  lines.push("thread_local! {");
  lines.push("    static FBB: RefCell<flatbuffers::FlatBufferBuilder<'static>> =");
  lines.push("        RefCell::new(flatbuffers::FlatBufferBuilder::new());");
  lines.push("}");
  lines.push("");
  lines.push("fn copy_finished<T>(");
  lines.push("    out: &mut [u8],");
  lines.push(
    "    build: impl FnOnce(&mut flatbuffers::FlatBufferBuilder<'static>) -> flatbuffers::WIPOffset<T>,",
  );
  lines.push(") -> Result<usize, TranscodeError> {");
  lines.push("    FBB.with(|cell| {");
  lines.push("        let mut fbb = cell.borrow_mut();");
  lines.push("        fbb.reset();");
  lines.push("        let root = build(&mut fbb);");
  lines.push('        fbb.finish_size_prefixed(root, Some("IGNX"));');
  lines.push("        let data = fbb.finished_data();");
  lines.push("        if data.len() > out.len() {");
  lines.push("            return Ok(data.len());");
  lines.push("        }");
  lines.push("        out[..data.len()].copy_from_slice(data);");
  lines.push("        Ok(data.len())");
  lines.push("    })");
  lines.push("}");
  lines.push("");
  lines.push("#[derive(Debug)]");
  lines.push("pub enum TranscodeError {");
  lines.push("    Parse,");
  lines.push("    UnknownEvent,");
  lines.push("}");
  lines.push("");
  lines.push("fn de_i64<'de, D>(d: D) -> Result<i64, D::Error>");
  lines.push("where");
  lines.push("    D: serde::Deserializer<'de>,");
  lines.push("{");
  lines.push("    let v = serde_json::Value::deserialize(d)?;");
  lines.push("    Ok(v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).unwrap_or(0))");
  lines.push("}");
  lines.push("");

  for (const e of m.enums) {
    lines.push(`fn ${toSnake(e.name)}_from_str(s: &str) -> backend::${e.name} {`);
    lines.push("    match s {");
    for (const v of e.values) {
      lines.push(`        "${v}" => backend::${e.name}::${v.toUpperCase()},`);
    }
    lines.push(`        _ => backend::${e.name}::default(),`);
    lines.push("    }");
    lines.push("}");
    lines.push("");
  }

  for (const t of m.tables) {
    lines.push(`#[derive(Deserialize, Default)]`);
    lines.push(`#[serde(rename_all = "camelCase")]`);
    lines.push(`pub struct ${t.name}Json {`);
    for (const f of t.fields) lines.push(emitJsonStruct(f));
    lines.push("}");
    lines.push("");
    lines.push(emitBuildFn(m, t));
    lines.push("");
  }

  for (const ev of m.events) {
    lines.push(emitSerializeFn(m, ev));
    lines.push("");
  }

  // Direct-args fast path (no JSON): one extern "C" fn per DIRECTABLE event type.
  // Fields are passed as direct FFI args; vectors as packed blobs; out[0] = event id.
  const readers = emitPackedReaders(m);
  if (readers.length > 0) {
    lines.push(...readers);
    lines.push("");
  }
  for (const ev of m.events) {
    if (!isDirectableEvent(m, ev)) continue;
    lines.push(emitDirectFn(m, ev));
    lines.push("");
  }

  lines.push(
    "pub fn serialize_event(event_id: u32, json: &[u8], out: &mut [u8]) -> Result<usize, TranscodeError> {",
  );
  lines.push("    match event_id {");
  m.events.forEach((ev) => {
    lines.push(`        ${eventId(ev.name)} => serialize_${toSnake(ev.name)}(json, out),`);
  });
  lines.push("        _ => Err(TranscodeError::UnknownEvent),");
  lines.push("    }");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}
