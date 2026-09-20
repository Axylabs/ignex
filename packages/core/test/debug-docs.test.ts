/**
 * @fileoverview Docs panel tests — inventory capping / uncapped listing and
 * the single-doc read path with traversal guards.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDoc } from "../src/debug/docs";
import { listAllDocs, scanDocsInventory } from "../src/debug/kt";

let dir: string;
let many: string;

const makeDocs = (root: string, names: string[]): void => {
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const n of names) writeFileSync(join(root, "docs", n), `# ${n}\n`);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ignex-docs-"));
  makeDocs(dir, ["a.md", "b.md"]);
  many = mkdtempSync(join(tmpdir(), "ignex-docs-many-"));
  makeDocs(
    many,
    Array.from({ length: 45 }, (_, i) => `d${String(i).padStart(2, "0")}.md`),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(many, { recursive: true, force: true });
});

describe("docs inventory", () => {
  it("default scan caps at 40 entries", async () => {
    const docs = await scanDocsInventory(many, ["docs"]);
    expect(docs.length).toBe(40);
  });

  it("listAllDocs returns the full inventory (read-path gate)", async () => {
    const docs = await listAllDocs(many, ["docs"]);
    expect(docs.length).toBe(45);
    expect(docs[0]?.path).toBe("docs/d00.md"); // sorted, README first then alpha
  });

  it("extracts titles from the first heading", async () => {
    const docs = await listAllDocs(dir, ["docs"]);
    expect(docs).toEqual([
      { path: "docs/a.md", title: "a.md" },
      { path: "docs/b.md", title: "b.md" },
    ]);
  });
});

describe("readDoc — one doc, confined to the inventory", () => {
  it("reads a listed doc with title, markdown and sanitized-or-null html", async () => {
    const doc = await readDoc(dir, ["docs"], "docs/a.md");
    expect(doc).not.toBeNull();
    expect(doc?.path).toBe("docs/a.md");
    expect(doc?.title).toBe("a.md");
    expect(doc?.markdown).toBe("# a.md\n");
    // No Bun global in vitest → server render unavailable → client fallback.
    expect(doc?.html).toBeNull();
  });

  it("returns null for traversal and unlisted paths (never reads outside)", async () => {
    expect(await readDoc(dir, ["docs"], "docs/nope.md")).toBeNull();
    expect(await readDoc(dir, ["docs"], "../secret.md")).toBeNull();
    expect(await readDoc(dir, ["docs"], "docs/../a.md")).toBeNull();
    expect(await readDoc(dir, ["docs"], "/etc/passwd")).toBeNull();
    expect(await readDoc(dir, ["docs"], "C:\\Windows\\x.md")).toBeNull();
  });
});
