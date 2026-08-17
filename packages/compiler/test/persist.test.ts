/**
 * Persistent per-module parse cache tests — round-trip serialize/rehydrate,
 * content-hash invalidation, and corrupt/version-mismatch handling.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPersistedModules,
  modulesCachePath,
  persistModules,
  serializeSourceFiles,
} from "../src/frontend/persist.js";
import { SourceManager } from "../src/frontend/source-manager.js";
import { hashString } from "../src/utils/hash.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ignex-persist-"));

const mkSourceManager = (): SourceManager => {
  const sm = new SourceManager();
  sm.fromSource("/abs/routes/index.get.ts", "routes/index.get.ts", "export default () => 'hi';\n");
  sm.fromSource(
    "/abs/routes/user.post.ts",
    "routes/user.post.ts",
    "import { Type } from '@sinclair/typebox';\nexport const schema = Type.Object({ name: Type.String() });\nexport default (ctx) => ctx.body;\n",
  );
  return sm;
};

describe("persistent parse cache", () => {
  it("round-trips source files through serialize → persist → load", () => {
    const outDir = tmp();
    const sm = mkSourceManager();

    persistModules(sm.all(), outDir);

    const loaded = loadPersistedModules(outDir);
    expect(loaded.size).toBe(2);

    const first = sm.all()[0];
    expect(loaded.has(hashString(first.content))).toBe(true);
    expect(loaded.get(hashString(first.content))?.handler?.body).toBe(first.handler?.body);
  });

  it("rehydrates an identical SourceFile from the disk cache (no re-parse)", () => {
    const outDir = tmp();
    const sm = mkSourceManager();
    persistModules(sm.all(), outDir);

    const loaded = loadPersistedModules(outDir);
    const rehydrated = new SourceManager(loaded);
    const file = rehydrated.fromSource(
      "/abs/routes/index.get.ts",
      "routes/index.get.ts",
      "export default () => 'hi';\n",
    );

    const fresh = sm.all()[0];
    expect(file.handler?.body).toBe(fresh.handler?.body);
    expect(file.ast.body.length).toBeGreaterThan(0);
    expect(file.imports).toEqual(fresh.imports);
    expect(file.symbols).toEqual(fresh.symbols);
  });

  it("misses the disk cache when content changes and parses from source", () => {
    const outDir = tmp();
    const sm = mkSourceManager();
    persistModules(sm.all(), outDir);

    const loaded = loadPersistedModules(outDir);
    const rehydrated = new SourceManager(loaded);

    // Changed content → different hash → no disk record → fresh parse.
    const changed = "export default () => 'changed';\n";
    const file = rehydrated.fromSource("/abs/routes/index.get.ts", "routes/index.get.ts", changed);
    expect(file.handler?.body).toContain("changed");
  });

  it("returns an empty map for a missing, corrupt, or wrong-version file", () => {
    const outDir = tmp();

    // Missing.
    expect(loadPersistedModules(outDir).size).toBe(0);

    // Corrupt.
    writeFileSync(modulesCachePath(outDir), "{ not json");
    expect(loadPersistedModules(outDir).size).toBe(0);

    // Wrong version.
    writeFileSync(
      modulesCachePath(outDir),
      JSON.stringify({ version: "999", modules: [{ hash: "x", parse: {} }] }),
    );
    expect(loadPersistedModules(outDir).size).toBe(0);
  });

  it("serializeSourceFiles produces deterministic, parseable JSON", () => {
    const sm = mkSourceManager();
    const a = serializeSourceFiles(sm.all());
    const b = serializeSourceFiles(sm.all());
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    expect(parsed.version).toBe("2");
    expect(parsed.modules).toHaveLength(2);
    expect(parsed.modules[0].hash).toBe(hashString(sm.all()[0].content));
  });

  it("drops records whose content hash does not match (tamper guard)", () => {
    const outDir = tmp();
    const sm = mkSourceManager();
    persistModules(sm.all(), outDir);

    // Tamper with one record's embedded content WITHOUT updating its hash — a
    // tampered-but-valid-JSON file. The integrity check must drop it instead
    // of rehydrating a ParseResult mismatched to the real source.
    const path = modulesCachePath(outDir);
    const file = JSON.parse(readFileSync(path, "utf-8")) as {
      version: string;
      modules: Array<{ hash: string; content: string; parse: unknown }>;
    };
    file.modules[0].content = "export default () => 'tampered';\n";
    writeFileSync(path, JSON.stringify(file));

    const loaded = loadPersistedModules(outDir);
    // The tampered record is rejected; the honest record is still served.
    expect(loaded.size).toBe(1);
    expect(loaded.has(hashString(file.modules[0].content))).toBe(false);
  });
});
