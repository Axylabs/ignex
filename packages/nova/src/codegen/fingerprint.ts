/**
 * Schema fingerprint — a stable FNV-1a 32-bit hash over the CANONICAL model
 * (event registry + table shapes + enums + wire version). Emitted into BOTH
 * the generated TS registry (`SCHEMA_FINGERPRINT`) and the generated Rust glue
 * (`SCHEMA_FINGERPRINT` → exposed as `fb_schema_fingerprint()`), so a cdylib
 * built from a DIFFERENT schema fails the bind-time self-test instead of
 * producing frames the client can't decode.
 *
 * The value only needs to be stable per schema (any collision would just
 * produce a false bind failure — harmless); it is NOT security.
 */

import { fnv1a32 } from "./hash";
import type { Model } from "./schema-model";

/** Stable comparator: ascending by name. */
function byName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

export function schemaFingerprint(m: Model, wireVersion: number): number {
  const lines: string[] = [`wire=${wireVersion}`];
  for (const e of [...m.events].sort(byName)) {
    lines.push(`event:${e.name}:${e.tableName}:${e.control ? "control" : "app"}`);
  }
  for (const t of [...m.tables].sort(byName)) {
    lines.push(`table:${t.name}`);
    for (const f of [...t.fields].sort((a, b) => {
      if (a.fbName < b.fbName) return -1;
      if (a.fbName > b.fbName) return 1;
      return 0;
    })) {
      lines.push(
        `  ${f.fbName}:${f.kind}:${f.required}:${f.enumName ?? ""}:${f.tableName ?? ""}:${f.bigint ? "bigint" : ""}`,
      );
    }
  }
  for (const e of [...m.enums].sort(byName)) {
    lines.push(`enum:${e.name}=${e.values.join(",")}`);
  }
  return fnv1a32(lines.join("\n"));
}
